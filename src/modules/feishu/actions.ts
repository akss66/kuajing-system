"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { FeishuClient } from "@/integrations/feishu/client";
import {
  canWriteFeishuCargo,
  readFeishuApiBaseUrl,
  readFeishuConfig,
} from "@/integrations/feishu/config";
import { requireAdmin, requireSuperAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import { createFeishuCargoMigrationService } from "./migration-service";
import { enqueueCargoSyncEvent } from "./outbox";
import { findCargoMigrationRunConfirmationSummary } from "./queries";
import type { FeishuSourceSheet } from "./source-reader";

const INTEGRATIONS_PATH = "/admin/system/integrations";

export type CargoMigrationActionState = ActionState & {
  availableSourceSheets?: FeishuSourceSheet[];
};

function createFeishuClient() {
  const config = readFeishuConfig();
  return {
    client: new FeishuClient({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: readFeishuApiBaseUrl(),
    }),
    config,
  };
}

function mapMigrationErrorMessage(error: KnownMigrationError) {
  switch (error.code) {
    case "ALREADY_IMPORTED":
      return "当前迁移已经导入系统，不能再次确认。";
    case "CATALOG_NOT_EMPTY":
      return "系统已经存在 SKU，不能执行首批迁移。";
    case "MIGRATION_NOT_CONFIRMABLE":
      return "当前预检结果未就绪，请先完成只读预检并解决阻断问题。";
    case "MIGRATION_NOT_FOUND":
      return "未找到预检记录，请重新执行只读预检。";
    case "SOURCE_STALE":
      return "源货盘已经变化，请重新执行只读预检。";
    default:
      return error.message;
  }
}

type KnownMigrationError = Error & {
  code?:
    | "ACTOR_NOT_FOUND"
    | "ALREADY_IMPORTED"
    | "CATALOG_NOT_EMPTY"
    | "FORBIDDEN_SUPER_ADMIN"
    | "MIGRATION_NOT_CONFIRMABLE"
    | "MIGRATION_NOT_FOUND"
    | "SOURCE_STALE";
};

function isKnownMigrationError(error: unknown): error is KnownMigrationError {
  return error instanceof Error && "code" in error;
}

export async function retryFeishuCargoSyncAction(
  _previousState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _previousState;
  void _formData;
  await requireAdmin();

  const config = readFeishuConfig();
  if (!canWriteFeishuCargo(config)) {
    return {
      message: "目标测试表未配置，当前只能做只读预检。",
      status: "error",
    };
  }

  await db.transaction((tx) =>
    enqueueCargoSyncEvent(tx, {
      idempotencyKey: `manual:${randomUUID()}`,
      reason: "administrator-manual-sync",
    }),
  );
  revalidatePath(INTEGRATIONS_PATH);
  return {
    message: "目标测试表同步已加入队列，后台任务会继续重试。",
    status: "success",
  };
}

export const manualFeishuCargoSyncAction = retryFeishuCargoSyncAction;

export async function testFeishuConnectionAction(
  _previousState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _previousState;
  void _formData;
  await requireAdmin();

  try {
    const { client, config } = createFeishuClient();
    const spreadsheet = await client.resolveWikiSpreadsheet(
      config.sourceWikiToken,
    );
    const sourceSheets = await client.listSheets(spreadsheet.spreadsheetToken);
    if (sourceSheets.length === 0) {
      throw new Error("源货盘不可访问，未找到任何工作表。");
    }

    if (!canWriteFeishuCargo(config)) {
      return {
        message: "只读连接验证成功：源货盘可访问，目标测试表尚未配置。",
        status: "success",
      };
    }

    await client.listSheets(config.targetSpreadsheetToken!);
    return {
      message: "只读连接验证成功：源货盘可访问，目标测试表也可读取。",
      status: "success",
    };
  } catch (error) {
    return {
      message:
        error instanceof Error
          ? error.message
          : "飞书连接验证失败，请稍后重试。",
      status: "error",
    };
  }
}

export async function createCargoPreflightAction(
  _previousState: CargoMigrationActionState,
  formData: FormData,
): Promise<CargoMigrationActionState> {
  void _previousState;
  const actor = await requireSuperAdmin();

  try {
    const { client, config } = createFeishuClient();
    const service = createFeishuCargoMigrationService();
    const sourceSheetId = String(formData.get("sourceSheetId") ?? "").trim();
    const result = await service.createCargoPreflight({
      actor,
      client,
      config: {
        sourceSheetId: sourceSheetId || config.sourceSheetId,
        sourceWikiToken: config.sourceWikiToken,
      },
    });

    if (result.status === "SOURCE_SHEET_SELECTION_REQUIRED") {
      return {
        availableSourceSheets: result.sheetOptions,
        message: "源货盘包含多个工作表，请先选择本次预检的源工作表。",
        status: "error",
      };
    }

    revalidatePath(INTEGRATIONS_PATH);
    if (result.status === "PREFLIGHT_BLOCKED") {
      return {
        availableSourceSheets: [],
        message: "只读预检已完成，但仍有阻断问题需要处理。",
        status: "error",
      };
    }

    return {
      availableSourceSheets: [],
      message: "只读预检已完成，可以继续确认首批导入。",
      status: "success",
    };
  } catch (error) {
    if (isKnownMigrationError(error)) {
      return {
        availableSourceSheets: [],
        message: mapMigrationErrorMessage(error),
        status: "error",
      };
    }

    return {
      availableSourceSheets: [],
      message:
        error instanceof Error ? error.message : "只读预检失败，请稍后重试。",
      status: "error",
    };
  }
}

export async function confirmCargoMigrationAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  void _previousState;
  const actor = await requireSuperAdmin();

  const runId = String(formData.get("runId") ?? "").trim();
  const runSummary = runId
    ? await findCargoMigrationRunConfirmationSummary(runId)
    : null;
  if (
    !runSummary ||
    runSummary.status !== "PREFLIGHT_READY" ||
    runSummary.blockingIssueCount > 0
  ) {
    return {
      message: "当前预检记录不可确认，请重新执行只读预检。",
      status: "error",
    };
  }

  const confirmationPhrase = String(
    formData.get("confirmationPhrase") ?? "",
  ).trim();
  const expectedPhrase = `确认迁移${runSummary.skuCount}个SKU`;
  if (confirmationPhrase !== expectedPhrase) {
    return {
      fieldErrors: {
        confirmationPhrase: [`请输入准确的确认语句：${expectedPhrase}`],
      },
      status: "error",
    };
  }

  try {
    const { client, config } = createFeishuClient();
    const service = createFeishuCargoMigrationService();
    const result = await service.confirmCargoMigration({
      actor,
      client,
      config: {
        sourceSheetId: config.sourceSheetId,
        sourceWikiToken: config.sourceWikiToken,
      },
      runId,
    });
    revalidatePath(INTEGRATIONS_PATH);
    return {
      message: `迁移已提交：${result.productCount} 个商品、${result.skuCount} 个SKU、${result.imageCount} 张图片已经导入系统。`,
      status: "success",
    };
  } catch (error) {
    if (isKnownMigrationError(error)) {
      return {
        message: mapMigrationErrorMessage(error),
        status: "error",
      };
    }

    return {
      message:
        error instanceof Error ? error.message : "迁移确认失败，请稍后重试。",
      status: "error",
    };
  }
}
