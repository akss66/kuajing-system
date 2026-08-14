import { and, desc, eq, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  adminUsers,
  authUsers,
  catalogAssets,
  feishuCargoMigrationRuns,
  integrationOutbox,
  products,
  skus,
} from "@/db/schema";

import type {
  CargoInheritedField,
  MigrationIssue,
  MigrationSummary,
  NormalizedCargoRow,
} from "./cargo-types";

type DatabaseLike = DbTransaction | typeof db;

const inheritedFieldLabels: Record<CargoInheritedField, string> = {
  cargoPrice: "货品价格",
  combination: "组合销售",
  image: "图片",
  price: "价格",
  productGroupKey: "商品分组",
  productName: "商品名称",
  productUrl: "商品链接",
  saleStatus: "销售状态",
  sourceSequence: "源序号",
  specification: "规格",
  weight: "重量",
};

function withSourceSequenceCount(
  summary: Omit<MigrationSummary, "sourceSequenceCount"> &
    Partial<Pick<MigrationSummary, "sourceSequenceCount">>,
): MigrationSummary {
  return {
    ...summary,
    sourceSequenceCount: summary.sourceSequenceCount ?? summary.productCount,
  };
}

function formatCurrencyFromFen(value: number) {
  return `¥${(value / 100).toFixed(2)}`;
}

function formatCurrencyFromMilliYuan(value: number) {
  const yuan = (value / 1_000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `¥${yuan}`;
}

function formatDateTime(value: Date | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(value);
}

function formatSafeHash(value: string) {
  return value.slice(0, 8);
}

function mapStatusLabel(status: (typeof feishuCargoMigrationRuns.$inferSelect)["status"]) {
  switch (status) {
    case "FAILED":
      return { label: "导入失败", tone: "danger" as const };
    case "IMPORTED":
      return { label: "已导入", tone: "success" as const };
    case "IMPORTING":
      return { label: "导入中", tone: "warning" as const };
    case "PREFLIGHT_BLOCKED":
      return { label: "预检阻断", tone: "danger" as const };
    case "PREFLIGHT_READY":
      return { label: "预检就绪", tone: "success" as const };
    case "PREFLIGHT_RUNNING":
      return { label: "预检进行中", tone: "warning" as const };
    case "STALE":
      return { label: "源数据已过期", tone: "warning" as const };
  }
}

function mapTargetSyncLabel(status: (typeof integrationOutbox.$inferSelect)["status"]) {
  switch (status) {
    case "COMPLETED":
      return { label: "同步完成", tone: "success" as const };
    case "FAILED":
      return { label: "等待重试", tone: "warning" as const };
    case "PROCESSING":
      return { label: "同步中", tone: "warning" as const };
    case "PENDING":
      return { label: "排队中", tone: "default" as const };
  }
}

function buildRowIssueLabels(
  issues: MigrationIssue[],
  sourceRowNumber: number,
) {
  return issues
    .filter((issue) => issue.sourceRowNumber === sourceRowNumber)
    .map((issue) => issue.message);
}

function buildInheritedLabels(row: NormalizedCargoRow) {
  return Object.entries(row.inheritedFrom).flatMap(([field, rowNumber]) => {
    if (typeof rowNumber !== "number") return [];
    return [`${inheritedFieldLabels[field as CargoInheritedField]}继承自第 ${rowNumber} 行`];
  });
}

export type CargoMigrationPanelRow = {
  defaultUnitPriceLabel: string;
  imageDigestLabel: string;
  imageStateLabel: string;
  inheritedFieldLabels: string[];
  issueLabels: string[];
  productGroupKey: string;
  productName: string;
  productUrl: string | null;
  saleStatusLabel: string;
  skuCode: string;
  skuName: string;
  sourceRowNumber: number;
  specification: string;
  totalQuantity: number;
  weightLabel: string;
};

export type CargoMigrationPanelRun = {
  blockingIssueCount: number;
  createdAtLabel: string | null;
  hashSafeSourceDigest: string;
  hashSafeSourceSpreadsheet: string;
  id: string;
  imageStateLabel: string;
  importedAtLabel: string | null;
  issueCount: number;
  rows: CargoMigrationPanelRow[];
  sourceRevision: number;
  sourceSheetId: string;
  status:
    | "FAILED"
    | "IMPORTED"
    | "IMPORTING"
    | "PREFLIGHT_BLOCKED"
    | "PREFLIGHT_READY"
    | "PREFLIGHT_RUNNING"
    | "STALE";
  statusLabel: string;
  statusTone: "danger" | "default" | "success" | "warning";
  summary: MigrationSummary;
  updatedAtLabel: string | null;
  warningIssueCount: number;
};

export type CargoMigrationRunConfirmationSummary = {
  blockingIssueCount: number;
  runId: string;
  skuCount: number;
  status:
    | "FAILED"
    | "IMPORTED"
    | "IMPORTING"
    | "PREFLIGHT_BLOCKED"
    | "PREFLIGHT_READY"
    | "PREFLIGHT_RUNNING"
    | "STALE";
};

export type CargoMigrationTargetSyncState = {
  canRetry: boolean;
  imageCount: number | null;
  lastErrorMessage: string | null;
  lastUpdatedLabel: string | null;
  rowCount: number | null;
  statusLabel: string;
  targetSheetId: string | null;
  tone: "danger" | "default" | "success" | "warning";
};

export async function findActiveSuperAdminMirrorId(
  database: DatabaseLike,
  actorUserId: string,
) {
  const [actor] = await database
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(
      and(
        eq(authUsers.id, actorUserId),
        eq(authUsers.role, "super_admin"),
      ),
    )
    .limit(1);
  if (!actor) {
    throw new Error("Super admin actor is not authorized");
  }

  const [mirror] = await database
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(
      and(
        eq(adminUsers.loginIdentifier, actor.email),
        eq(adminUsers.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (!mirror) {
    throw new Error("Super admin mirror profile was not active");
  }

  return mirror.id;
}

export async function findProductBySourceSequence(
  database: DatabaseLike,
  sourceSequence: string,
) {
  const [product] = await database
    .select({ id: products.id })
    .from(products)
    .where(eq(products.sourceSequence, sourceSequence))
    .limit(1);
  return product ?? null;
}

export async function findSkuByCode(database: DatabaseLike, skuCode: string) {
  const [sku] = await database
    .select({
      id: skus.id,
      productId: skus.productId,
      productSourceSequence: products.sourceSequence,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .where(eq(skus.skuCode, skuCode))
    .limit(1);
  return sku ?? null;
}

export async function findSkuCodesByProductId(
  database: DatabaseLike,
  productId: string,
) {
  return await database
    .select({ skuCode: skus.skuCode })
    .from(skus)
    .where(eq(skus.productId, productId));
}

export async function findMigrationRunForUpdate(
  tx: DbTransaction,
  runId: string,
) {
  const [run] = await tx
    .select()
    .from(feishuCargoMigrationRuns)
    .where(eq(feishuCargoMigrationRuns.id, runId))
    .for("update")
    .limit(1);
  return run ?? null;
}

export async function findMigrationRun(
  database: DatabaseLike,
  runId: string,
) {
  const [run] = await database
    .select()
    .from(feishuCargoMigrationRuns)
    .where(eq(feishuCargoMigrationRuns.id, runId))
    .limit(1);
  return run ?? null;
}

export async function findCargoMigrationRunConfirmationSummary(runId: string) {
  const [run] = await db
    .select({
      id: feishuCargoMigrationRuns.id,
      issuesJson: feishuCargoMigrationRuns.issuesJson,
      status: feishuCargoMigrationRuns.status,
      summaryJson: feishuCargoMigrationRuns.summaryJson,
    })
    .from(feishuCargoMigrationRuns)
    .where(eq(feishuCargoMigrationRuns.id, runId))
    .limit(1);
  if (!run) {
    return null;
  }

  const issues = run.issuesJson as MigrationIssue[];
  const summary = run.summaryJson as MigrationSummary;

  return {
    blockingIssueCount: issues.filter((issue) => issue.severity === "BLOCKING")
      .length,
    runId: run.id,
    skuCount: summary.skuCount,
    status: run.status,
  } satisfies CargoMigrationRunConfirmationSummary;
}

export async function importedMigrationExists(
  database: DatabaseLike,
  excludingRunId?: string,
) {
  const conditions = excludingRunId
    ? and(
        eq(feishuCargoMigrationRuns.status, "IMPORTED"),
        sql`${feishuCargoMigrationRuns.id} <> ${excludingRunId}::uuid`,
      )
    : eq(feishuCargoMigrationRuns.status, "IMPORTED");

  const [run] = await database
    .select({ id: feishuCargoMigrationRuns.id })
    .from(feishuCargoMigrationRuns)
    .where(conditions)
    .limit(1);
  return Boolean(run);
}

export async function catalogAssetExistsForDigest(
  tx: DbTransaction,
  contentSha256: string,
) {
  const [asset] = await tx
    .select({
      byteSize: catalogAssets.byteSize,
      contentSha256: catalogAssets.contentSha256,
      id: catalogAssets.id,
      mimeType: catalogAssets.mimeType,
      originalFileName: catalogAssets.originalFileName,
      storageKey: catalogAssets.storageKey,
    })
    .from(catalogAssets)
    .where(eq(catalogAssets.contentSha256, contentSha256))
    .limit(1);
  return asset ?? null;
}

export async function getLatestCargoMigrationRun() {
  const [run] = await db
    .select()
    .from(feishuCargoMigrationRuns)
    .orderBy(desc(feishuCargoMigrationRuns.updatedAt))
    .limit(1);
  if (!run) return null;

  const rows = run.normalizedRowsJson as NormalizedCargoRow[];
  const issues = run.issuesJson as MigrationIssue[];
  const status = mapStatusLabel(run.status);

  return {
    blockingIssueCount: issues.filter((issue) => issue.severity === "BLOCKING")
      .length,
    createdAtLabel: formatDateTime(run.createdAt),
    hashSafeSourceDigest: formatSafeHash(run.sourceDigest),
    hashSafeSourceSpreadsheet: formatSafeHash(run.sourceSpreadsheetHash),
    id: run.id,
    imageStateLabel: run.status === "IMPORTED" ? "已导入" : "已暂存",
    importedAtLabel: formatDateTime(run.importedAt),
    issueCount: issues.length,
    rows: rows.map((row) => ({
      defaultUnitPriceLabel:
        typeof row.defaultUnitPriceMilliYuan === "number"
          ? formatCurrencyFromMilliYuan(row.defaultUnitPriceMilliYuan)
          : formatCurrencyFromFen(row.defaultUnitPriceFen),
      imageDigestLabel: formatSafeHash(row.imageContentSha256),
      imageStateLabel: run.status === "IMPORTED" ? "已导入" : "已暂存",
      inheritedFieldLabels: buildInheritedLabels(row),
      issueLabels: buildRowIssueLabels(issues, row.sourceRowNumber),
      productGroupKey: row.productGroupKey,
      productName: row.productName,
      productUrl: row.productUrl,
      saleStatusLabel: row.saleStatus === "SELLABLE" ? "可售" : "不可售",
      skuCode: row.skuCode,
      skuName: row.skuName,
      sourceRowNumber: row.sourceRowNumber,
      specification: row.specification ?? "—",
      totalQuantity: row.totalQuantity,
      weightLabel: row.weightGrams == null ? "—" : `${row.weightGrams}g`,
    })),
    sourceRevision: run.sourceRevision,
    sourceSheetId: run.sourceSheetId,
    status: run.status,
    statusLabel: status.label,
    statusTone: status.tone,
    summary: withSourceSequenceCount(
      run.summaryJson as Omit<MigrationSummary, "sourceSequenceCount"> &
        Partial<Pick<MigrationSummary, "sourceSequenceCount">>,
    ),
    updatedAtLabel: formatDateTime(run.updatedAt),
    warningIssueCount: issues.filter((issue) => issue.severity === "WARNING")
      .length,
  } satisfies CargoMigrationPanelRun;
}

export async function getLatestCargoTargetSyncState(targetSheetId?: string | null) {
  const [event] = await db
    .select({
      lastErrorMessage: integrationOutbox.lastErrorMessage,
      payload: integrationOutbox.payload,
      status: integrationOutbox.status,
      updatedAt: integrationOutbox.updatedAt,
    })
    .from(integrationOutbox)
    .where(eq(integrationOutbox.eventType, "FEISHU_CARGO_SYNC"))
    .orderBy(desc(integrationOutbox.updatedAt))
    .limit(1);

  if (!event) {
    return {
      canRetry: false,
      imageCount: null,
      lastErrorMessage: null,
      lastUpdatedLabel: null,
      rowCount: null,
      statusLabel: targetSheetId ? "尚未同步" : "等待配置",
      targetSheetId: targetSheetId ?? null,
      tone: targetSheetId ? "default" : "warning",
    } satisfies CargoMigrationTargetSyncState;
  }

  const status = mapTargetSyncLabel(event.status);
  const payload = event.payload as
    | {
        imageCount?: number;
        rowCount?: number;
      }
    | undefined;

  return {
    canRetry: event.status === "FAILED",
    imageCount: payload?.imageCount ?? null,
    lastErrorMessage: event.lastErrorMessage,
    lastUpdatedLabel: formatDateTime(event.updatedAt),
    rowCount: payload?.rowCount ?? null,
    statusLabel: status.label,
    targetSheetId: targetSheetId ?? null,
    tone: status.tone,
  } satisfies CargoMigrationTargetSyncState;
}
