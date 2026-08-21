"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { FeishuClient } from "@/integrations/feishu/client";
import {
  canImportFeishuCargo,
  canMirrorFeishuCatalog,
  canWriteFeishuCargo,
  hasFeishuCargoTargetConfig,
  readFeishuApiBaseUrl,
  readFeishuConfig,
} from "@/integrations/feishu/config";
import { requireAdmin, requireSuperAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  createCatalogFieldRefreshService,
  type CatalogFieldRefreshPreview,
} from "./catalog-field-refresh";
import { createFeishuCargoMigrationService } from "./migration-service";
import { enqueueCargoSyncEvent } from "./outbox";
import {
  findCargoMigrationRunConfirmationSummary,
  findLatestImportedCargoRefreshBaseline,
} from "./queries";
import type { FeishuSourceSheet } from "./source-reader";

const INTEGRATIONS_PATH = "/admin/system/integrations";
const CATALOG_PATH = "/admin/catalog";
const INVENTORY_PATH = "/admin/inventory";

const READ_ONLY_CONFIRM_MESSAGE =
  "系统数据库导入尚未启用，需显式设置 FEISHU_CARGO_IMPORT_ENABLED=true 后才允许确认首批导入；飞书源表仍保持只读。";
const READ_ONLY_SYNC_MESSAGE =
  "当前仍处于只读发布阶段，目标测试表写入已禁用。需显式设置 FEISHU_CARGO_WRITES_ENABLED=true 后再执行目标同步。";
const TARGET_NOT_CONFIGURED_MESSAGE =
  "目标测试表尚未配置，当前只能执行只读预检。";

export type CargoMigrationActionState = ActionState & {
  availableSourceSheets?: FeishuSourceSheet[];
};

function createFeishuClient(config = readFeishuConfig()) {
  return {
    client: new FeishuClient({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: readFeishuApiBaseUrl(),
    }),
    config,
  };
}

type KnownMigrationError = Error & {
  code?:
    | "ACTOR_NOT_FOUND"
    | "ALREADY_IMPORTED"
    | "CATALOG_NOT_EMPTY"
    | "FORBIDDEN_SUPER_ADMIN"
    | "MIGRATION_NOT_CONFIRMABLE"
    | "MIGRATION_NOT_FOUND"
    | "ROLLOUT_READ_ONLY"
    | "SOURCE_STALE";
};

function mapMigrationErrorMessage(error: KnownMigrationError) {
  switch (error.code) {
    case "ALREADY_IMPORTED":
      return "当前迁移已经导入系统，不能再次确认。";
    case "CATALOG_NOT_EMPTY":
      return "系统中已经存在 SKU，不能执行首批迁移。";
    case "MIGRATION_NOT_CONFIRMABLE":
      return "当前预检结果未就绪，请先完成只读预检并解决阻塞问题。";
    case "MIGRATION_NOT_FOUND":
      return "未找到预检记录，请重新执行只读预检。";
    case "ROLLOUT_READ_ONLY":
      return READ_ONLY_CONFIRM_MESSAGE;
    case "SOURCE_STALE":
      return "源货盘已经变化，请重新执行只读预检。";
    default:
      return error.message;
  }
}

function isKnownMigrationError(error: unknown): error is KnownMigrationError {
  return error instanceof Error && "code" in error;
}

function mapCatalogRefreshErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "SKU_SET_MISMATCH":
      return "飞书货盘与系统的 SKU 集合不一致，本次未更新。请先核对新增或缺失的 SKU。";
    case "PRODUCT_GROUPING_CONFLICT":
      return "飞书货盘的商品分组与系统现有归属冲突，本次未更新。请先核对 SKU 的商品归属。";
    case "SOURCE_SEQUENCE_COUNT_MISMATCH":
      return "飞书货盘的商品数量与已导入基线不一致，本次未更新。请先核对货盘结构。";
    case "SKU_COUNT_MISMATCH":
      return "飞书货盘的 SKU 数量与已导入基线不一致，本次未更新。请先核对新增或缺失的 SKU。";
    case "PARSER_BLOCKING_ISSUES":
      return "飞书货盘存在无法解析的阻断问题，本次未更新。请先修正货盘内容。";
    case "NO_SYNCABLE_SKUS":
      return "飞书货盘中没有可同步的有效 SKU，本次未更新。";
    case "SOURCE_IMAGE_DOWNLOAD_FAILED":
      return "读取飞书货盘图片失败，请稍后重试；本次未修改商品或库存。";
    case "SOURCE_CHANGED_DURING_SYNC":
      return "飞书货盘在同步期间发生了变化，本次未更新。请重新点击同步。";
    case "SOURCE_SYNC_SUPERSEDED":
      return "已有更新的一次飞书同步请求，本次较早请求已停止。请以最新同步结果为准。";
    case "MIRROR_ACTIVE_RESERVATIONS":
      return "系统当前存在活动库存占用，迁移镜像已安全停止。请先取消或完成相关订单后重试。";
    case "SOURCE_SHEET_SELECTION_REQUIRED":
      return "已导入基线缺少明确的源工作表，本次未更新。请联系系统维护人员核对配置。";
    default:
      return "暂时无法读取飞书货盘，请稍后重试；本次未修改商品或库存。";
  }
}

export async function syncFeishuCatalogFieldsAction(
  _previousState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _previousState;
  void _formData;
  const actor = await requireSuperAdmin();

  let result: CatalogFieldRefreshPreview;
  try {
    const baseline = await findLatestImportedCargoRefreshBaseline();
    if (!baseline) {
      return {
        message: "尚无已导入的飞书货盘基线，请先完成首批导入。",
        status: "error",
      };
    }

    const config = readFeishuConfig();
    if (!canMirrorFeishuCatalog(config)) {
      return {
        message: "飞书迁移镜像功能当前已关闭。",
        status: "error",
      };
    }
    const { client } = createFeishuClient(config);
    const service = createCatalogFieldRefreshService();
    result = await service.apply({
      actorUserId: actor.userId,
      client,
      mode: "MIGRATION_MIRROR",
      reason: "超级管理员执行迁移期飞书货盘全量镜像",
      sourceSheetId: baseline.sourceSheetId,
      sourceWikiToken: config.sourceWikiToken,
    });
  } catch (error) {
    return {
      message: mapCatalogRefreshErrorMessage(error),
      status: "error",
    };
  }

  revalidatePath(CATALOG_PATH);
  revalidatePath(INVENTORY_PATH);
  return {
    message: `飞书迁移镜像完成：共 ${result.skuCount} 个 SKU；新增 ${result.createdSkuCount} 个 SKU、${result.createdProductCount} 个商品，更新 ${result.matchedSkuCount} 个 SKU，归档 ${result.archivedSkuCount} 个飞书缺失 SKU；${result.inventoryAdjustedSkuCount} 个 SKU 的库存已按飞书校准；${result.degradedSkuCount} 个资料不完整的 SKU 已保持不可售。`,
    status: "success",
  };
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
      message: hasFeishuCargoTargetConfig(config)
        ? READ_ONLY_SYNC_MESSAGE
        : TARGET_NOT_CONFIGURED_MESSAGE,
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

    if (!hasFeishuCargoTargetConfig(config)) {
      return {
        message: "只读连接验证成功：源货盘可访问，目标测试表尚未配置。",
        status: "success",
      };
    }

    await client.listSheets(config.targetSpreadsheetToken!);
    return {
      message: canWriteFeishuCargo(config)
        ? "只读连接验证成功：源货盘可访问，目标测试表也可读取。"
        : "只读连接验证成功：源货盘和目标测试表都可读取，当前仍为只读发布阶段。",
      status: "success",
    };
  } catch (error) {
    return {
      message:
        error instanceof Error ? error.message : "飞书连接验证失败，请稍后重试。",
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
        message: "只读预检已完成，但仍有阻塞问题需要处理。",
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
  const config = readFeishuConfig();
  const runId = String(formData.get("runId") ?? "").trim();
  const runSummary = runId
    ? await findCargoMigrationRunConfirmationSummary(runId)
    : null;
  const isImportedReplay = runSummary?.status === "IMPORTED";

  if (!isImportedReplay && !canImportFeishuCargo(config)) {
    return {
      message: READ_ONLY_CONFIRM_MESSAGE,
      status: "error",
    };
  }

  if (
    !runSummary ||
    (!isImportedReplay &&
      (runSummary.status !== "PREFLIGHT_READY" ||
        runSummary.blockingIssueCount > 0))
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
    const { client } = createFeishuClient();
    const service = createFeishuCargoMigrationService();
    const result = await service.confirmCargoMigration({
      actor,
      client,
      config: {
        cargoImportEnabled: config.cargoImportEnabled,
        cargoWritesEnabled: config.cargoWritesEnabled,
        sourceSheetId: config.sourceSheetId,
        sourceWikiToken: config.sourceWikiToken,
      },
      runId,
    });
    revalidatePath(INTEGRATIONS_PATH);
    return {
      message: `已写入本系统数据库：${result.sourceSequenceCount} 个来源序号、${result.skuCount} 个SKU、${result.imageCount} 张图片已完成回填。`,
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
