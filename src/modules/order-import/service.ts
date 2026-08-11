import { createHash } from "node:crypto";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  orderImportBatches,
  orderImportRows,
  orderLines,
  skuAliases,
  stores,
} from "@/db/schema";
import { assertStoreOwnership } from "@/modules/identity/guards";
import { encryptPii, parsePiiEncryptionKey } from "@/shared/pii-crypto";

import {
  classifyTemuRows,
  parseTemuOrderWorkbook,
  type ClassifiedTemuResult,
} from "./temu-parser";

const PREVIEW_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const INSERT_CHUNK_SIZE = 400;

export class ImportPreviewError extends Error {
  constructor(
    public readonly code:
      | "STORE_DISABLED"
      | "PREVIEW_NOT_FOUND"
      | "EMPTY_DATA"
      | "INVALID_FILE_NAME",
    message: string,
  ) {
    super(message);
    this.name = "ImportPreviewError";
  }
}

export type ImportPreviewSummary = ClassifiedTemuResult["summary"];

export type ImportPreviewRowView = {
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
  externalOrderNo: string | null;
  externalSubOrderNo: string | null;
  externalSku: string | null;
  quantity: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ImportPreviewView = {
  batchId: string;
  fileName: string;
  storeId: string;
  storeName: string;
  expiresAt: Date;
  summary: ImportPreviewSummary;
  rows: ImportPreviewRowView[];
};

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function exactAliasMap(
  storeId: string,
  externalSkus: readonly string[],
) {
  if (externalSkus.length === 0) return new Map<string, string>();

  const aliases = await db
    .select({
      externalSku: skuAliases.externalSku,
      skuId: skuAliases.skuId,
      storeId: skuAliases.storeId,
    })
    .from(skuAliases)
    .where(
      and(
        eq(skuAliases.active, true),
        inArray(skuAliases.externalSku, [...new Set(externalSkus)]),
        or(eq(skuAliases.storeId, storeId), isNull(skuAliases.storeId)),
      ),
    );

  const resolved = new Map<string, string>();
  for (const alias of aliases.filter((row) => row.storeId === null)) {
    resolved.set(alias.externalSku, alias.skuId);
  }
  for (const alias of aliases.filter((row) => row.storeId === storeId)) {
    resolved.set(alias.externalSku, alias.skuId);
  }
  return resolved;
}

async function duplicateSubOrders(
  storeId: string,
  externalSubOrderNumbers: readonly string[],
) {
  if (externalSubOrderNumbers.length === 0) return new Set<string>();

  const duplicates = await db
    .select({ externalSubOrderNo: orderLines.externalSubOrderNo })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.storeId, storeId),
        inArray(
          orderLines.externalSubOrderNo,
          [...new Set(externalSubOrderNumbers)],
        ),
      ),
    );

  return new Set(
    duplicates.flatMap((row) =>
      row.externalSubOrderNo ? [row.externalSubOrderNo] : [],
    ),
  );
}

function classifiedRowsForStorage(
  classified: ClassifiedTemuResult,
  piiKey: Buffer,
) {
  const parsedRows = classified.rows.map((row) => ({
    batchId: "",
    errorCode: null,
    errorMessage: null,
    externalOrderNo: row.externalOrderNo,
    externalSku: row.externalSku,
    externalSubOrderNo: row.externalSubOrderNo,
    productAttributes: row.productAttributes,
    productName: row.productName,
    quantity: row.quantity,
    recipientPayloadEncrypted: encryptPii(row.recipient, piiKey),
    resolvedSkuId: row.resolvedSkuId,
    rowNumber: row.rowNumber,
    status: row.status,
  }));
  const invalidRows = classified.issues.map((issue) => ({
    batchId: "",
    errorCode: issue.code,
    errorMessage: issue.message,
    externalOrderNo: null,
    externalSku: null,
    externalSubOrderNo: null,
    productAttributes: null,
    productName: null,
    quantity: null,
    recipientPayloadEncrypted: null,
    resolvedSkuId: null,
    rowNumber: issue.rowNumber,
    status: "INVALID" as const,
  }));

  return [...parsedRows, ...invalidRows].sort(
    (first, second) => first.rowNumber - second.rowNumber,
  );
}

function previewRows(classified: ClassifiedTemuResult): ImportPreviewRowView[] {
  return [
    ...classified.rows.map((row) => ({
      errorCode: null,
      errorMessage: null,
      externalOrderNo: row.externalOrderNo,
      externalSku: row.externalSku,
      externalSubOrderNo: row.externalSubOrderNo,
      quantity: row.quantity,
      rowNumber: row.rowNumber,
      status: row.status,
    })),
    ...classified.issues.map((issue) => ({
      errorCode: issue.code,
      errorMessage: issue.message,
      externalOrderNo: null,
      externalSku: null,
      externalSubOrderNo: null,
      quantity: null,
      rowNumber: issue.rowNumber,
      status: "INVALID" as const,
    })),
  ].sort((first, second) => first.rowNumber - second.rowNumber);
}

export async function createTemuImportPreview(input: {
  actorUserId: string;
  customerId: string;
  storeId: string;
  fileName: string;
  buffer: Uint8Array;
}): Promise<ImportPreviewView> {
  await assertStoreOwnership(input.customerId, input.storeId);

  const [store] = await db
    .select({ id: stores.id, name: stores.name, status: stores.status })
    .from(stores)
    .where(and(eq(stores.id, input.storeId), eq(stores.customerId, input.customerId)))
    .limit(1);
  if (!store || store.status !== "ACTIVE") {
    throw new ImportPreviewError("STORE_DISABLED", "该店铺已停用，不能导入订单");
  }
  if (!input.fileName || input.fileName.length > 255) {
    throw new ImportPreviewError("INVALID_FILE_NAME", "Excel 文件名无效");
  }

  const parsed = await parseTemuOrderWorkbook({
    buffer: input.buffer,
    fileName: input.fileName,
  });
  if (parsed.rows.length === 0 && parsed.issues.length === 0) {
    throw new ImportPreviewError("EMPTY_DATA", "Excel 文件中没有订单数据");
  }

  const [skuIdByExactAlias, duplicateSubOrderNumbers] = await Promise.all([
    exactAliasMap(
      input.storeId,
      parsed.rows.map((row) => row.externalSku),
    ),
    duplicateSubOrders(
      input.storeId,
      parsed.rows.map((row) => row.externalSubOrderNo),
    ),
  ]);
  const classified = classifyTemuRows(parsed, {
    duplicateSubOrderNumbers,
    skuIdByExactAlias,
  });
  const piiKey = parsePiiEncryptionKey();
  const rowsForStorage = classifiedRowsForStorage(classified, piiKey);
  const expiresAt = new Date(Date.now() + PREVIEW_LIFETIME_MS);
  const fileSha256 = createHash("sha256").update(input.buffer).digest("hex");

  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(orderImportBatches)
      .values({
        customerId: input.customerId,
        duplicateRows: classified.summary.duplicate,
        expiresAt,
        fileSha256,
        fileSizeBytes: input.buffer.byteLength,
        invalidRows: classified.summary.invalid,
        originalFileName: input.fileName,
        readyRows: classified.summary.ready,
        storeId: input.storeId,
        totalRows: classified.summary.total,
        unknownSkuRows: classified.summary.unknownSku,
      })
      .returning({ id: orderImportBatches.id });

    for (const rowChunk of chunks(rowsForStorage, INSERT_CHUNK_SIZE)) {
      await tx.insert(orderImportRows).values(
        rowChunk.map((row) => ({
          ...row,
          batchId: batch.id,
        })),
      );
    }

    await tx.insert(auditLogs).values({
      action: "TEMU_IMPORT_PREVIEW_CREATED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        fileSha256,
        storeId: input.storeId,
        summary: classified.summary,
      },
      beforeJson: {},
      entityId: batch.id,
      entityType: "ORDER_IMPORT_BATCH",
      reason: "客户上传 TEMU 原始订单并生成预览",
    });

    return batch.id;
  });

  return {
    batchId,
    expiresAt,
    fileName: input.fileName,
    rows: previewRows(classified),
    storeId: input.storeId,
    storeName: store.name,
    summary: classified.summary,
  };
}

export async function getCustomerImportPreview(
  customerId: string,
  batchId: string,
): Promise<ImportPreviewView> {
  const [batch] = await db
    .select({
      batchId: orderImportBatches.id,
      duplicate: orderImportBatches.duplicateRows,
      expiresAt: orderImportBatches.expiresAt,
      fileName: orderImportBatches.originalFileName,
      invalid: orderImportBatches.invalidRows,
      ready: orderImportBatches.readyRows,
      storeId: orderImportBatches.storeId,
      storeName: stores.name,
      total: orderImportBatches.totalRows,
      unknownSku: orderImportBatches.unknownSkuRows,
    })
    .from(orderImportBatches)
    .innerJoin(stores, eq(stores.id, orderImportBatches.storeId))
    .where(
      and(
        eq(orderImportBatches.id, batchId),
        eq(orderImportBatches.customerId, customerId),
      ),
    )
    .limit(1);
  if (!batch) {
    throw new ImportPreviewError("PREVIEW_NOT_FOUND", "找不到该导入预览");
  }

  const rows = await db
    .select({
      errorCode: orderImportRows.errorCode,
      errorMessage: orderImportRows.errorMessage,
      externalOrderNo: orderImportRows.externalOrderNo,
      externalSku: orderImportRows.externalSku,
      externalSubOrderNo: orderImportRows.externalSubOrderNo,
      quantity: orderImportRows.quantity,
      rowNumber: orderImportRows.rowNumber,
      status: orderImportRows.status,
    })
    .from(orderImportRows)
    .where(eq(orderImportRows.batchId, batchId))
    .orderBy(asc(orderImportRows.rowNumber));

  return {
    batchId: batch.batchId,
    expiresAt: batch.expiresAt,
    fileName: batch.fileName,
    rows,
    storeId: batch.storeId,
    storeName: batch.storeName,
    summary: {
      duplicate: batch.duplicate,
      invalid: batch.invalid,
      ready: batch.ready,
      total: batch.total,
      unknownSku: batch.unknownSku,
    },
  };
}

export async function listActiveCustomerStores(customerId: string) {
  return db
    .select({ id: stores.id, name: stores.name, platform: stores.platform })
    .from(stores)
    .where(and(eq(stores.customerId, customerId), eq(stores.status, "ACTIVE")))
    .orderBy(asc(stores.name));
}

export async function refreshActiveImportPreviewsForAlias(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    storeId: string;
    externalSku: string;
    skuId: string;
  },
) {
  const activeBatches = await tx
    .select({ id: orderImportBatches.id })
    .from(orderImportBatches)
    .where(
      and(
        eq(orderImportBatches.storeId, input.storeId),
        eq(orderImportBatches.status, "PREVIEW"),
        gt(orderImportBatches.expiresAt, new Date()),
      ),
    )
    .for("update");
  if (activeBatches.length === 0) return 0;

  const updatedRows = await tx
    .update(orderImportRows)
    .set({
      errorCode: null,
      errorMessage: null,
      resolvedSkuId: input.skuId,
      status: "READY",
    })
    .where(
      and(
        inArray(
          orderImportRows.batchId,
          activeBatches.map((batch) => batch.id),
        ),
        eq(orderImportRows.status, "UNKNOWN_SKU"),
        eq(orderImportRows.externalSku, input.externalSku),
      ),
    )
    .returning({ batchId: orderImportRows.batchId });

  const affectedByBatch = new Map<string, number>();
  for (const row of updatedRows) {
    affectedByBatch.set(
      row.batchId,
      (affectedByBatch.get(row.batchId) ?? 0) + 1,
    );
  }

  for (const [batchId, affectedRows] of affectedByBatch) {
    await tx
      .update(orderImportBatches)
      .set({
        readyRows: sql`${orderImportBatches.readyRows} + ${affectedRows}`,
        unknownSkuRows: sql`${orderImportBatches.unknownSkuRows} - ${affectedRows}`,
        updatedAt: new Date(),
      })
      .where(eq(orderImportBatches.id, batchId));
    await tx.insert(auditLogs).values({
      action: "TEMU_IMPORT_PREVIEW_RECLASSIFIED",
      actorId: input.actorUserId,
      actorType: "ADMIN",
      afterJson: {
        affectedRows,
        externalSku: input.externalSku,
        skuId: input.skuId,
      },
      beforeJson: { status: "UNKNOWN_SKU" },
      entityId: batchId,
      entityType: "ORDER_IMPORT_BATCH",
      reason: "管理员新增 SKU 映射后自动刷新导入预览",
    });
  }

  return updatedRows.length;
}
