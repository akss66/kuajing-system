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
import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import { enqueueCargoSyncEvent } from "./outbox";

export async function manualFeishuCargoSyncAction(
  _previousState: ActionState,
): Promise<ActionState> {
  void _previousState;
  await requireAdmin();

  const config = readFeishuConfig();
  if (!canWriteFeishuCargo(config)) {
    return {
      message: "飞书目标测试表未配置，当前只允许预检，不允许手动写入货盘。",
      status: "error",
    };
  }

  await db.transaction((tx) =>
    enqueueCargoSyncEvent(tx, {
      idempotencyKey: `manual:${randomUUID()}`,
      reason: "administrator-manual-sync",
    }),
  );
  revalidatePath("/admin/system/integrations");
  return { message: "货盘同步已加入队列，将由任务进程执行。", status: "success" };
}

export async function testFeishuConnectionAction(
  _previousState: ActionState,
): Promise<ActionState> {
  void _previousState;
  await requireAdmin();
  try {
    const config = readFeishuConfig();
    const client = new FeishuClient({
      appId: config.appId,
      appSecret: config.appSecret,
      baseUrl: readFeishuApiBaseUrl(),
    });
    const spreadsheet = await client.resolveWikiSpreadsheet(
      config.sourceWikiToken,
    );
    const sheets = await client.listSheets(spreadsheet.spreadsheetToken);
    if (sheets.length === 0) throw new Error("源飞书电子表格没有工作表");
    return {
      message: `连接成功：应用可访问源飞书电子表格，共 ${sheets.length} 个工作表。`,
      status: "success",
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : "飞书连接测试失败。",
      status: "error",
    };
  }
}
