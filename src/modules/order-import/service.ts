import { createHash } from "node:crypto";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  aiSkuMatchSuggestions,
  inventoryBalances,
  inventoryReservations,
  orderImportBatches,
  orderImportRowFulfillmentItems,
  orderImportRows,
  orderLines,
  orderShipments,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";
import { assertStoreOwnership } from "@/modules/identity/guards";
import { resolveUnitPrice } from "@/modules/catalog/pricing";
import { encryptPii, parsePiiEncryptionKey } from "@/shared/pii-crypto";

import {
  classifyTemuRows,
  parseTemuOrderWorkbook,
  type ClassifiedTemuResult,
} from "./temu-parser";
import {
  deriveImportSkuResolution,
  multiplyImportQuantity,
} from "./sku-resolution";

const PREVIEW_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const INSERT_CHUNK_SIZE = 400;

export class ImportPreviewError extends Error {
  constructor(
    public readonly code:
      | "STORE_DISABLED"
      | "PREVIEW_NOT_FOUND"
      | "PREVIEW_EXPIRED"
      | "IMPORT_ROW_NOT_FOUND"
      | "IMPORT_ROW_CONFLICT"
      | "INVALID_ROW_OVERRIDE"
      | "SKU_NOT_AVAILABLE"
      | "INSUFFICIENT_STOCK"
      | "AI_SUGGESTION_INVALID"
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
  id: string;
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
  externalOrderNo: string | null;
  externalSubOrderNo: string | null;
  externalSku: string | null;
  fulfillmentItems: Array<{
    availableQuantity: number | null;
    effectiveQuantity: number;
    fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
    id: string;
    isPrimary: boolean;
    position: number;
    resolvedSkuId: string | null;
    skuCode: string;
    unitPriceMilliYuan: number | null;
  }>;
  quantity: number | null;
  effectiveQuantity: number | null;
  quantityMultiplier: number;
  fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
  resolutionMethod:
    | "EXACT"
    | "STORE_ALIAS"
    | "GLOBAL_ALIAS"
    | "NORMALIZED_SUFFIX"
    | "MANUAL_OVERRIDE"
    | "AI_CONFIRMED"
    | "CUSTOMER_SUPPLIED"
    | "LEGACY";
  revision: number;
  resolvedSku: {
    id: string;
    skuCode: string;
    name: string;
    unitPriceMilliYuan: number | null;
  } | null;
  siblingCandidates: Array<{
    id: string;
    skuCode: string;
    name: string;
    availableQuantity: number;
  }>;
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

function isSkuAvailable(input: {
  archivedAt: Date | null;
  cargoUnitPriceMilliYuan: number | null;
  lifecycleStatus: string;
  saleStatus: string;
}) {
  return (
    input.lifecycleStatus === "ACTIVE" &&
    input.saleStatus === "SELLABLE" &&
    input.cargoUnitPriceMilliYuan !== null &&
    input.archivedAt === null
  );
}

type ExactSkuResolution = {
  resolutionMethod:
    | "EXACT"
    | "STORE_ALIAS"
    | "GLOBAL_ALIAS"
    | "NORMALIZED_SUFFIX";
  skuId: string;
};

async function exactSkuResolutionMap(
  tx: DbTransaction,
  storeId: string,
  externalSkus: readonly string[],
): Promise<Map<string, ExactSkuResolution>> {
  if (externalSkus.length === 0) return new Map();

  const uniqueExternalSkus = [...new Set(externalSkus)];
  const derivationByExternalSku = new Map<
    string,
    ReturnType<typeof deriveImportSkuResolution>
  >();
  for (const externalSku of uniqueExternalSkus) {
    try {
      derivationByExternalSku.set(
        externalSku,
        deriveImportSkuResolution(externalSku),
      );
    } catch {
      // Classification records this row as INVALID with a safe message.
    }
  }
  const lookupSkus = [
    ...new Set(
      [...derivationByExternalSku.values()].flatMap(
        (derivation) => derivation.lookupCandidates,
      ),
    ),
  ];
  if (lookupSkus.length === 0) return new Map();
  const [standardSkus, aliases] = await Promise.all([
    tx
      .select({
        archivedAt: skus.archivedAt,
        cargoUnitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
        lifecycleStatus: skus.lifecycleStatus,
        saleStatus: skus.saleStatus,
        skuCode: skus.skuCode,
        skuId: skus.id,
      })
      .from(skus)
      .where(inArray(skus.skuCode, lookupSkus)),
    tx
      .select({
        archivedAt: skus.archivedAt,
        cargoUnitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
        externalSku: skuAliases.externalSku,
        lifecycleStatus: skus.lifecycleStatus,
        saleStatus: skus.saleStatus,
        skuId: skuAliases.skuId,
        storeId: skuAliases.storeId,
      })
      .from(skuAliases)
      .innerJoin(skus, eq(skus.id, skuAliases.skuId))
      .where(
        and(
          eq(skuAliases.active, true),
          inArray(skuAliases.externalSku, lookupSkus),
          or(eq(skuAliases.storeId, storeId), isNull(skuAliases.storeId)),
        ),
      ),
  ]);

  const candidates = new Map<
    string,
    {
      eligible: boolean;
      method: "EXACT" | "STORE_ALIAS" | "GLOBAL_ALIAS";
      skuId: string;
    }
  >();
  for (const standardSku of standardSkus) {
    candidates.set(standardSku.skuCode, {
      eligible: isSkuAvailable(standardSku),
      method: "EXACT",
      skuId: standardSku.skuId,
    });
  }
  for (const alias of aliases.filter((row) => row.storeId === null)) {
    candidates.set(alias.externalSku, {
      eligible: isSkuAvailable(alias),
      method: "GLOBAL_ALIAS",
      skuId: alias.skuId,
    });
  }
  for (const alias of aliases.filter((row) => row.storeId === storeId)) {
    candidates.set(alias.externalSku, {
      eligible: isSkuAvailable(alias),
      method: "STORE_ALIAS",
      skuId: alias.skuId,
    });
  }

  const resolved = new Map<string, ExactSkuResolution>();
  for (const [externalSku, derivation] of derivationByExternalSku) {
    for (const [candidateIndex, lookupSku] of derivation.lookupCandidates.entries()) {
      const candidate = candidates.get(lookupSku);
      if (!candidate) continue;
      // A higher-priority explicit candidate that is unavailable is a hard
      // block. Falling through could silently substitute a different SKU.
      if (!candidate.eligible) break;
      resolved.set(externalSku, {
        resolutionMethod:
          candidateIndex === 0 ? candidate.method : "NORMALIZED_SUFFIX",
        skuId: candidate.skuId,
      });
      break;
    }
  }
  return resolved;
}

async function duplicateSubOrders(
  tx: DbTransaction,
  storeId: string,
  externalSubOrderNumbers: readonly string[],
) {
  if (externalSubOrderNumbers.length === 0) return new Set<string>();

  const duplicates = await tx
    .select({ externalSubOrderNo: orderLines.externalSubOrderNo })
    .from(orderLines)
    .where(
      and(
        eq(orderLines.storeId, storeId),
        eq(orderLines.deduplicationActive, true),
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

async function duplicateExternalOrders(
  tx: DbTransaction,
  storeId: string,
  externalOrderNumbers: readonly string[],
) {
  if (externalOrderNumbers.length === 0) return new Set<string>();

  const duplicates = await tx
    .select({ externalOrderNo: orderShipments.externalOrderNo })
    .from(orderShipments)
    .where(
      and(
        eq(orderShipments.storeId, storeId),
        eq(orderShipments.deduplicationActive, true),
        inArray(
          orderShipments.externalOrderNo,
          [...new Set(externalOrderNumbers)],
        ),
      ),
    );

  return new Set(duplicates.map((row) => row.externalOrderNo));
}

function classifiedRowsForStorage(
  classified: ClassifiedTemuResult,
  piiKey: Buffer,
) {
  const recipientByExternalOrder = new Map<
    string,
    { encrypted: string; serialized: string }
  >();
  const parsedRows = classified.rows.map((row) => {
    const serializedRecipient = JSON.stringify(row.recipient);
    const existingRecipient = recipientByExternalOrder.get(row.externalOrderNo);
    const recipientPayloadEncrypted =
      existingRecipient?.serialized === serializedRecipient
        ? existingRecipient.encrypted
        : encryptPii(row.recipient, piiKey);
    if (!existingRecipient) {
      recipientByExternalOrder.set(row.externalOrderNo, {
        encrypted: recipientPayloadEncrypted,
        serialized: serializedRecipient,
      });
    }

    return {
      batchId: "",
      errorCode: null,
      errorMessage: null,
      externalOrderNo: row.externalOrderNo,
      externalSku: row.externalSku,
      finalSkuCode:
        row.fulfillmentMode === "CUSTOMER_SUPPLIED" ? row.externalSku : null,
      externalSubOrderNo: row.externalSubOrderNo,
      productAttributes: row.productAttributes,
      productName: row.productName,
      quantity: row.quantity,
      effectiveQuantity: row.effectiveQuantity,
      fulfillmentMode: row.fulfillmentMode,
      quantityMultiplier: row.quantityMultiplier,
      resolutionMethod: row.resolutionMethod,
      revision: 0,
      recipientPayloadEncrypted,
      resolvedSkuId: row.resolvedSkuId,
      rowNumber: row.rowNumber,
      status: row.status,
    };
  });
  const invalidRows = classified.issues.map((issue) => ({
    batchId: "",
    errorCode: issue.code,
    errorMessage: issue.message,
    externalOrderNo: null,
    externalSku: null,
    finalSkuCode: null,
    externalSubOrderNo: null,
    productAttributes: null,
    productName: null,
    quantity: null,
    effectiveQuantity: null,
    fulfillmentMode: "SYSTEM_SKU" as const,
    quantityMultiplier: 1,
    resolutionMethod: "LEGACY" as const,
    revision: 0,
    recipientPayloadEncrypted: null,
    resolvedSkuId: null,
    rowNumber: issue.rowNumber,
    status: "INVALID" as const,
  }));

  return [...parsedRows, ...invalidRows].sort(
    (first, second) => first.rowNumber - second.rowNumber,
  );
}

export async function createTemuImportPreview(input: {
  actorUserId: string;
  customerId: string;
  storeId: string;
  fileName: string;
  mimeType?: string;
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
  return db.transaction((tx) =>
    createTemuImportPreviewInTransaction(tx, {
      ...input,
      storeName: store.name,
    }),
  );
}

export async function createTemuImportPreviewInTransaction(
  tx: DbTransaction,
  input: {
    actorUserId: string | null;
    customerId: string;
    storeId: string;
    storeName: string;
    storeGroupId?: string;
    fileName: string;
    mimeType?: string;
    buffer: Uint8Array;
    expiresAt?: Date;
  },
): Promise<ImportPreviewView> {
  if (!input.fileName || input.fileName.length > 255) {
    throw new ImportPreviewError("INVALID_FILE_NAME", "Excel 文件名无效");
  }

  const parsed = await parseTemuOrderWorkbook({
    buffer: input.buffer,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });
  if (parsed.rows.length === 0 && parsed.issues.length === 0) {
    throw new ImportPreviewError("EMPTY_DATA", "Excel 文件中没有订单数据");
  }

  const [
    skuIdByExternalSku,
    duplicateSubOrderNumbers,
    duplicateExternalOrderNumbers,
  ] = await Promise.all([
    exactSkuResolutionMap(
      tx,
      input.storeId,
      parsed.rows.map((row) => row.externalSku),
    ),
    duplicateSubOrders(
      tx,
      input.storeId,
      parsed.rows.map((row) => row.externalSubOrderNo),
    ),
    duplicateExternalOrders(
      tx,
      input.storeId,
      parsed.rows.map((row) => row.externalOrderNo),
    ),
  ]);
  const classified = classifyTemuRows(parsed, {
    duplicateExternalOrderNumbers,
    duplicateSubOrderNumbers,
    skuIdByExactAlias: skuIdByExternalSku,
  });
  const piiKey = parsePiiEncryptionKey();
  const rowsForStorage = classifiedRowsForStorage(classified, piiKey);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + PREVIEW_LIFETIME_MS);
  const fileSha256 = createHash("sha256").update(input.buffer).digest("hex");

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
      storeGroupId: input.storeGroupId,
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

  await revalidateBatchInventory(tx, batch.id);
  const [validatedBatch] = await tx
    .select({
      duplicate: orderImportBatches.duplicateRows,
      invalid: orderImportBatches.invalidRows,
      ready: orderImportBatches.readyRows,
      total: orderImportBatches.totalRows,
      unknownSku: orderImportBatches.unknownSkuRows,
    })
    .from(orderImportBatches)
    .where(eq(orderImportBatches.id, batch.id));
  const finalSummary = validatedBatch ?? classified.summary;
  const finalRows = await enrichPreviewRows(
    tx,
    await loadStoredPreviewRows(tx, batch.id),
  );

  await tx.insert(auditLogs).values({
    action: "TEMU_IMPORT_PREVIEW_CREATED",
    actorId: input.actorUserId,
    actorType: "CUSTOMER",
    afterJson: {
      fileSha256,
      storeGroupId: input.storeGroupId ?? null,
      storeId: input.storeId,
      summary: finalSummary,
    },
    beforeJson: {},
    entityId: batch.id,
    entityType: "ORDER_IMPORT_BATCH",
    reason: "客户上传 TEMU 原始订单并生成预览",
  });

  return {
    batchId: batch.id,
    expiresAt,
    fileName: input.fileName,
    rows: finalRows,
    storeId: input.storeId,
    storeName: input.storeName,
    summary: finalSummary,
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

  const rows = await loadStoredPreviewRows(db, batchId);

  return {
    batchId: batch.batchId,
    expiresAt: batch.expiresAt,
    fileName: batch.fileName,
    rows: await enrichPreviewRows(db, rows),
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
  const [eligibleSku] = await tx
    .select({ id: skus.id })
    .from(skus)
    .where(
      and(
        eq(skus.id, input.skuId),
        eq(skus.lifecycleStatus, "ACTIVE"),
        eq(skus.saleStatus, "SELLABLE"),
        isNotNull(skus.cargoUnitPriceMilliYuan),
        isNull(skus.archivedAt),
      ),
    )
    .for("share")
    .limit(1);
  if (!eligibleSku) return 0;

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

  const unknownRows = await tx
    .select({
      batchId: orderImportRows.batchId,
      externalSku: orderImportRows.externalSku,
      id: orderImportRows.id,
      quantity: orderImportRows.quantity,
    })
    .from(orderImportRows)
    .where(
      and(
        inArray(
          orderImportRows.batchId,
          activeBatches.map((batch) => batch.id),
        ),
        eq(orderImportRows.fulfillmentMode, "SYSTEM_SKU"),
        eq(orderImportRows.status, "UNKNOWN_SKU"),
        isNotNull(orderImportRows.externalSku),
        isNotNull(orderImportRows.quantity),
        isNull(orderImportRows.resolvedSkuId),
      ),
    )
    .for("update");

  const candidates = unknownRows.flatMap((row) => {
    const externalSku = row.externalSku;
    const quantity = row.quantity;
    if (!externalSku || !quantity) return [];
    try {
      const derivation = deriveImportSkuResolution(externalSku);
      return derivation.lookupCandidates.includes(input.externalSku)
        ? [{ ...row, derivation, externalSku, quantity }]
        : [];
    } catch {
      return [];
    }
  });
  const resolutions = await exactSkuResolutionMap(
    tx,
    input.storeId,
    candidates.map((row) => row.externalSku),
  );

  const affectedByBatch = new Map<string, number>();
  for (const row of candidates) {
    const resolution = resolutions.get(row.externalSku);
    if (!resolution) continue;
    const [updatedRow] = await tx
      .update(orderImportRows)
      .set({
        effectiveQuantity: multiplyImportQuantity(
          row.quantity,
          row.derivation.quantityMultiplier,
        ),
        errorCode: null,
        errorMessage: null,
        quantityMultiplier: row.derivation.quantityMultiplier,
        resolutionMethod: resolution.resolutionMethod,
        resolvedSkuId: resolution.skuId,
        revision: sql`${orderImportRows.revision} + 1`,
        status: "READY",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orderImportRows.id, row.id),
          eq(orderImportRows.status, "UNKNOWN_SKU"),
        ),
      )
      .returning({ batchId: orderImportRows.batchId });
    if (!updatedRow) continue;
    affectedByBatch.set(
      updatedRow.batchId,
      (affectedByBatch.get(updatedRow.batchId) ?? 0) + 1,
    );
  }

  for (const [batchId, affectedRows] of affectedByBatch) {
    await revalidateBatchInventory(tx, batchId);
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

  return [...affectedByBatch.values()].reduce(
    (total, affectedRows) => total + affectedRows,
    0,
  );
}

async function loadStoredPreviewRows(
  tx: Pick<DbTransaction, "select">,
  batchId: string,
): Promise<StoredPreviewRow[]> {
  const rows = await tx
    .select({
      effectiveQuantity: orderImportRows.effectiveQuantity,
      errorCode: orderImportRows.errorCode,
      errorMessage: orderImportRows.errorMessage,
      externalOrderNo: orderImportRows.externalOrderNo,
      externalSku: orderImportRows.externalSku,
      externalSubOrderNo: orderImportRows.externalSubOrderNo,
      finalSkuCode: orderImportRows.finalSkuCode,
      fulfillmentMode: orderImportRows.fulfillmentMode,
      id: orderImportRows.id,
      quantity: orderImportRows.quantity,
      quantityMultiplier: orderImportRows.quantityMultiplier,
      resolutionMethod: orderImportRows.resolutionMethod,
      resolvedSkuId: orderImportRows.resolvedSkuId,
      revision: orderImportRows.revision,
      rowNumber: orderImportRows.rowNumber,
      status: orderImportRows.status,
    })
    .from(orderImportRows)
    .where(eq(orderImportRows.batchId, batchId))
    .orderBy(asc(orderImportRows.rowNumber));
  if (rows.length === 0) return [];
  const additionalItems = await tx
    .select({
      effectiveQuantity: orderImportRowFulfillmentItems.effectiveQuantity,
      finalSkuCode: orderImportRowFulfillmentItems.finalSkuCode,
      fulfillmentMode: orderImportRowFulfillmentItems.fulfillmentMode,
      id: orderImportRowFulfillmentItems.id,
      position: orderImportRowFulfillmentItems.position,
      resolvedSkuId: orderImportRowFulfillmentItems.resolvedSkuId,
      rowId: orderImportRowFulfillmentItems.rowId,
    })
    .from(orderImportRowFulfillmentItems)
    .where(inArray(orderImportRowFulfillmentItems.rowId, rows.map((row) => row.id)))
    .orderBy(
      asc(orderImportRowFulfillmentItems.rowId),
      asc(orderImportRowFulfillmentItems.position),
    );
  const itemsByRowId = new Map<string, typeof additionalItems>();
  for (const item of additionalItems) {
    const items = itemsByRowId.get(item.rowId) ?? [];
    items.push(item);
    itemsByRowId.set(item.rowId, items);
  }
  return rows.map((row) => ({
    ...row,
    additionalItems: itemsByRowId.get(row.id) ?? [],
  }));
}

export async function revalidateBatchInventory(
  tx: DbTransaction,
  batchId: string,
  now = new Date(),
) {
  const candidateRows = await tx
    .select({
      effectiveQuantity: orderImportRows.effectiveQuantity,
      errorCode: orderImportRows.errorCode,
      fulfillmentMode: orderImportRows.fulfillmentMode,
      id: orderImportRows.id,
      resolvedSkuId: orderImportRows.resolvedSkuId,
      status: orderImportRows.status,
    })
    .from(orderImportRows)
    .where(eq(orderImportRows.batchId, batchId))
    .for("update");
  const additionalItems =
    candidateRows.length === 0
      ? []
      : await tx
          .select({
            effectiveQuantity: orderImportRowFulfillmentItems.effectiveQuantity,
            fulfillmentMode: orderImportRowFulfillmentItems.fulfillmentMode,
            resolvedSkuId: orderImportRowFulfillmentItems.resolvedSkuId,
            rowId: orderImportRowFulfillmentItems.rowId,
          })
          .from(orderImportRowFulfillmentItems)
          .where(
            inArray(
              orderImportRowFulfillmentItems.rowId,
              candidateRows.map((row) => row.id),
            ),
          )
          .for("update");
  const rowById = new Map(candidateRows.map((row) => [row.id, row]));
  const demandBySku = new Map<string, number>();
  const rowIdsBySku = new Map<string, Set<string>>();
  const addDemand = (input: {
    effectiveQuantity: number | null;
    fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
    resolvedSkuId: string | null;
    rowId: string;
  }) => {
    const row = rowById.get(input.rowId);
    if (
      !row ||
      input.fulfillmentMode !== "SYSTEM_SKU" ||
      !input.resolvedSkuId ||
      !input.effectiveQuantity ||
      row.status === "DUPLICATE" ||
      row.status === "INVALID"
    ) {
      return;
    }
    const demand =
      (demandBySku.get(input.resolvedSkuId) ?? 0) + input.effectiveQuantity;
    if (!Number.isSafeInteger(demand) || demand > 2_147_483_647) {
      throw new ImportPreviewError(
        "INVALID_ROW_OVERRIDE",
        "同一 SKU 的合计发货数量超出系统范围",
      );
    }
    demandBySku.set(input.resolvedSkuId, demand);
    const rowIds = rowIdsBySku.get(input.resolvedSkuId) ?? new Set<string>();
    rowIds.add(input.rowId);
    rowIdsBySku.set(input.resolvedSkuId, rowIds);
  };
  for (const row of candidateRows) {
    addDemand({
      effectiveQuantity: row.effectiveQuantity,
      fulfillmentMode: row.fulfillmentMode,
      resolvedSkuId: row.resolvedSkuId,
      rowId: row.id,
    });
  }
  for (const item of additionalItems) addDemand(item);
  const insufficientSkuIds = new Set<string>();
  const insufficientMessageByRowId = new Map<string, string>();
  for (const skuId of [...demandBySku.keys()].sort()) {
    const [balance] = await tx
      .select({ totalQuantity: inventoryBalances.totalQuantity })
      .from(inventoryBalances)
      .where(eq(inventoryBalances.skuId, skuId))
      .for("update")
      .limit(1);
    const [reserved] = await tx
      .select({
        quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`.mapWith(Number),
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.skuId, skuId),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
    const available =
      (balance?.totalQuantity ?? 0) - (reserved?.quantity ?? 0);
    const required = demandBySku.get(skuId)!;
    if (available < required) {
      insufficientSkuIds.add(skuId);
      const message = `对应 SKU 库存不足：需 ${required} 件，可用 ${Math.max(available, 0)} 件，请更换 SKU 或减少数量`;
      for (const rowId of rowIdsBySku.get(skuId) ?? []) {
        if (!insufficientMessageByRowId.has(rowId)) {
          insufficientMessageByRowId.set(rowId, message);
        }
      }
    }
  }
  for (const row of candidateRows) {
    const insufficientMessage = insufficientMessageByRowId.get(row.id);
    if (insufficientMessage) {
      await tx
        .update(orderImportRows)
        .set({
          errorCode: "INSUFFICIENT_STOCK",
          errorMessage: insufficientMessage,
          status: "UNKNOWN_SKU",
          updatedAt: now,
        })
        .where(eq(orderImportRows.id, row.id));
    } else if (row.errorCode === "INSUFFICIENT_STOCK") {
      await tx
        .update(orderImportRows)
        .set({ errorCode: null, errorMessage: null, status: "READY", updatedAt: now })
        .where(eq(orderImportRows.id, row.id));
    }
  }

  const statuses = await tx
    .select({ status: orderImportRows.status })
    .from(orderImportRows)
    .where(eq(orderImportRows.batchId, batchId));
  const count = (status: (typeof statuses)[number]["status"]) =>
    statuses.filter((row) => row.status === status).length;
  await tx
    .update(orderImportBatches)
    .set({
      duplicateRows: count("DUPLICATE"),
      invalidRows: count("INVALID"),
      readyRows: count("READY"),
      unknownSkuRows: count("UNKNOWN_SKU"),
      updatedAt: now,
    })
    .where(eq(orderImportBatches.id, batchId));

  return {
    insufficientSkuIds,
    summary: {
      duplicate: count("DUPLICATE"),
      invalid: count("INVALID"),
      ready: count("READY"),
      total: statuses.length,
      unknownSku: count("UNKNOWN_SKU"),
    },
  };
}

type AdditionalFulfillmentItemMutationInput = {
  actorUserId: string;
  batchId: string;
  customerId: string;
  expectedRevision: number;
  rowId: string;
};

async function resolveManualFulfillmentItem(
  tx: DbTransaction,
  input: { effectiveQuantity: number; skuCode: string },
) {
  if (
    !Number.isSafeInteger(input.effectiveQuantity) ||
    input.effectiveQuantity <= 0 ||
    input.effectiveQuantity > 2_147_483_647
  ) {
    throw new ImportPreviewError(
      "INVALID_ROW_OVERRIDE",
      "实际发货数量必须是有效正整数",
    );
  }
  const finalSkuCode = input.skuCode.trim();
  if (!finalSkuCode || finalSkuCode.length > 160) {
    throw new ImportPreviewError(
      "INVALID_ROW_OVERRIDE",
      "请填写不超过 160 个字符的最终 SKU",
    );
  }
  const fulfillmentMode = deriveImportSkuResolution(finalSkuCode).fulfillmentMode;
  if (fulfillmentMode === "CUSTOMER_SUPPLIED") {
    return { finalSkuCode, fulfillmentMode, resolvedSkuId: null } as const;
  }
  const [sku] = await tx
    .select({ id: skus.id, skuCode: skus.skuCode })
    .from(skus)
    .where(
      and(
        eq(skus.skuCode, finalSkuCode),
        eq(skus.lifecycleStatus, "ACTIVE"),
        eq(skus.saleStatus, "SELLABLE"),
        isNull(skus.archivedAt),
      ),
    )
    .for("share")
    .limit(1);
  if (!sku) {
    throw new ImportPreviewError(
      "SKU_NOT_AVAILABLE",
      "SKU 不存在、已下架或不可售",
    );
  }
  try {
    await resolveUnitPrice(tx, { skuId: sku.id });
  } catch {
    throw new ImportPreviewError(
      "SKU_NOT_AVAILABLE",
      "SKU 暂无有效拿货价，不能用于本次订单",
    );
  }
  return {
    finalSkuCode: sku.skuCode,
    fulfillmentMode,
    resolvedSkuId: sku.id,
  } as const;
}

async function mutateCustomerImportRowFulfillmentItem(
  input: AdditionalFulfillmentItemMutationInput &
    (
      | { kind: "ADD"; effectiveQuantity: number; skuCode: string }
      | {
          kind: "UPDATE";
          effectiveQuantity: number;
          itemId: string;
          skuCode: string;
        }
      | { kind: "REMOVE"; itemId: string }
    ),
): Promise<ImportPreviewRowView> {
  const transactionOutcome = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select({
        expiresAt: orderImportBatches.expiresAt,
        id: orderImportBatches.id,
        status: orderImportBatches.status,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
        ),
      )
      .for("update")
      .limit(1);
    if (!batch) {
      throw new ImportPreviewError("PREVIEW_NOT_FOUND", "找不到该导入预览");
    }
    const now = new Date();
    if (batch.status !== "PREVIEW") {
      throw new ImportPreviewError(
        "INVALID_ROW_OVERRIDE",
        "该导入预览当前不能修改",
      );
    }
    if (batch.expiresAt <= now) {
      await tx
        .update(orderImportBatches)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(orderImportBatches.id, batch.id));
      return { kind: "EXPIRED" as const };
    }
    const [row] = await tx
      .select({
        id: orderImportRows.id,
        revision: orderImportRows.revision,
        status: orderImportRows.status,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.id, input.rowId),
          eq(orderImportRows.batchId, batch.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) {
      throw new ImportPreviewError(
        "IMPORT_ROW_NOT_FOUND",
        "找不到该导入明细行",
      );
    }
    if (row.revision !== input.expectedRevision) {
      throw new ImportPreviewError(
        "IMPORT_ROW_CONFLICT",
        "该行已被其他操作更新，请刷新后重试",
      );
    }
    if (row.status === "DUPLICATE" || row.status === "INVALID") {
      throw new ImportPreviewError(
        "INVALID_ROW_OVERRIDE",
        "重复或格式错误的行不能手动修改",
      );
    }
    const existingItems = await tx
      .select({
        id: orderImportRowFulfillmentItems.id,
        position: orderImportRowFulfillmentItems.position,
      })
      .from(orderImportRowFulfillmentItems)
      .where(eq(orderImportRowFulfillmentItems.rowId, row.id))
      .orderBy(asc(orderImportRowFulfillmentItems.position))
      .for("update");

    let affectedItemId: string;
    if (input.kind === "ADD") {
      if (existingItems.length >= 19) {
        throw new ImportPreviewError(
          "INVALID_ROW_OVERRIDE",
          "每条上传明细最多可配置 20 个实际发货货品",
        );
      }
      const usedPositions = new Set(existingItems.map((item) => item.position));
      const position = Array.from({ length: 19 }, (_, index) => index + 2).find(
        (candidate) => !usedPositions.has(candidate),
      );
      if (!position) {
        throw new ImportPreviewError(
          "INVALID_ROW_OVERRIDE",
          "该上传明细已达到货品数量上限",
        );
      }
      const resolved = await resolveManualFulfillmentItem(tx, input);
      const [inserted] = await tx
        .insert(orderImportRowFulfillmentItems)
        .values({
          effectiveQuantity: input.effectiveQuantity,
          finalSkuCode: resolved.finalSkuCode,
          fulfillmentMode: resolved.fulfillmentMode,
          position,
          resolvedSkuId: resolved.resolvedSkuId,
          rowId: row.id,
        })
        .returning({ id: orderImportRowFulfillmentItems.id });
      affectedItemId = inserted.id;
    } else {
      const existing = existingItems.find((item) => item.id === input.itemId);
      if (!existing) {
        throw new ImportPreviewError(
          "IMPORT_ROW_NOT_FOUND",
          "找不到该实际发货货品",
        );
      }
      affectedItemId = existing.id;
      if (input.kind === "REMOVE") {
        await tx
          .delete(orderImportRowFulfillmentItems)
          .where(eq(orderImportRowFulfillmentItems.id, existing.id));
      } else {
        const resolved = await resolveManualFulfillmentItem(tx, input);
        await tx
          .update(orderImportRowFulfillmentItems)
          .set({
            effectiveQuantity: input.effectiveQuantity,
            finalSkuCode: resolved.finalSkuCode,
            fulfillmentMode: resolved.fulfillmentMode,
            resolvedSkuId: resolved.resolvedSkuId,
            updatedAt: now,
          })
          .where(eq(orderImportRowFulfillmentItems.id, existing.id));
      }
    }

    const [updated] = await tx
      .update(orderImportRows)
      .set({
        errorCode: null,
        errorMessage: null,
        revision: row.revision + 1,
        status: "READY",
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportRows.id, row.id),
          eq(orderImportRows.revision, input.expectedRevision),
        ),
      )
      .returning({ id: orderImportRows.id });
    if (!updated) {
      throw new ImportPreviewError(
        "IMPORT_ROW_CONFLICT",
        "该行已被其他操作更新，请刷新后重试",
      );
    }
    await revalidateBatchInventory(tx, batch.id, now);
    await tx.insert(auditLogs).values({
      action: `TEMU_IMPORT_FULFILLMENT_ITEM_${input.kind}`,
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        itemId: affectedItemId,
        operation: input.kind,
        revision: row.revision + 1,
      },
      beforeJson: { revision: row.revision },
      entityId: row.id,
      entityType: "ORDER_IMPORT_ROW",
      reason: "客户调整上传订单的实际发货货品",
    });
    return { kind: "UPDATED" as const };
  });
  if (transactionOutcome.kind === "EXPIRED") {
    throw new ImportPreviewError("PREVIEW_EXPIRED", "导入预览已过期，请重新上传");
  }
  const preview = await getCustomerImportPreview(input.customerId, input.batchId);
  const result = preview.rows.find((row) => row.id === input.rowId);
  if (!result) {
    throw new ImportPreviewError(
      "IMPORT_ROW_NOT_FOUND",
      "找不到更新后的导入明细行",
    );
  }
  return result;
}

export async function addCustomerImportRowFulfillmentItem(
  input: AdditionalFulfillmentItemMutationInput & {
    effectiveQuantity: number;
    skuCode: string;
  },
) {
  return mutateCustomerImportRowFulfillmentItem({ ...input, kind: "ADD" });
}

export async function updateCustomerImportRowFulfillmentItem(
  input: AdditionalFulfillmentItemMutationInput & {
    effectiveQuantity: number;
    itemId: string;
    skuCode: string;
  },
) {
  return mutateCustomerImportRowFulfillmentItem({ ...input, kind: "UPDATE" });
}

export async function removeCustomerImportRowFulfillmentItem(
  input: AdditionalFulfillmentItemMutationInput & { itemId: string },
) {
  return mutateCustomerImportRowFulfillmentItem({ ...input, kind: "REMOVE" });
}

export async function updateCustomerImportRowOverride(input: {
  actorUserId: string;
  aiSuggestionId?: string;
  customerId: string;
  batchId: string;
  rowId: string;
  expectedRevision: number;
  skuCode?: string;
  effectiveQuantity: number;
}): Promise<ImportPreviewRowView> {
  if (
    !Number.isSafeInteger(input.effectiveQuantity) ||
    input.effectiveQuantity <= 0 ||
    input.effectiveQuantity > 2_147_483_647
  ) {
    throw new ImportPreviewError(
      "INVALID_ROW_OVERRIDE",
      "实际发货数量必须是有效正整数",
    );
  }
  const normalizedSkuCode = input.skuCode?.trim();
  const transactionOutcome = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select({
        expiresAt: orderImportBatches.expiresAt,
        id: orderImportBatches.id,
        status: orderImportBatches.status,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
        ),
      )
      .for("update")
      .limit(1);
    if (!batch) {
      throw new ImportPreviewError("PREVIEW_NOT_FOUND", "找不到该导入预览");
    }
    const now = new Date();
    if (batch.status !== "PREVIEW") {
      throw new ImportPreviewError(
        "INVALID_ROW_OVERRIDE",
        "该导入预览当前不能修改",
      );
    }
    if (batch.expiresAt <= now) {
      await tx
        .update(orderImportBatches)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(orderImportBatches.id, batch.id));
      return { kind: "EXPIRED" as const };
    }

    const [row] = await tx
      .select({
        effectiveQuantity: orderImportRows.effectiveQuantity,
        finalSkuCode: orderImportRows.finalSkuCode,
        fulfillmentMode: orderImportRows.fulfillmentMode,
        id: orderImportRows.id,
        resolvedSkuId: orderImportRows.resolvedSkuId,
        revision: orderImportRows.revision,
        status: orderImportRows.status,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.id, input.rowId),
          eq(orderImportRows.batchId, batch.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) {
      throw new ImportPreviewError(
        "IMPORT_ROW_NOT_FOUND",
        "找不到该导入明细行",
      );
    }
    if (row.revision !== input.expectedRevision) {
      throw new ImportPreviewError(
        "IMPORT_ROW_CONFLICT",
        "该行已被其他操作更新，请刷新后重试",
      );
    }
    if (row.status === "DUPLICATE" || row.status === "INVALID") {
      throw new ImportPreviewError(
        "INVALID_ROW_OVERRIDE",
        "重复或格式错误的行不能手动修改",
      );
    }

    let fulfillmentMode = row.fulfillmentMode;
    let finalSkuCode = row.finalSkuCode;
    let resolvedSkuId = row.resolvedSkuId;
    if (normalizedSkuCode) {
      fulfillmentMode = deriveImportSkuResolution(normalizedSkuCode).fulfillmentMode;
      finalSkuCode = normalizedSkuCode;
    }
    if (fulfillmentMode === "CUSTOMER_SUPPLIED") {
      if (!finalSkuCode) {
        throw new ImportPreviewError(
          "INVALID_ROW_OVERRIDE",
          "客户自有货 SKU 不能为空",
        );
      }
      resolvedSkuId = null;
    } else if (normalizedSkuCode) {
      const [sku] = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(
          and(
            eq(skus.skuCode, normalizedSkuCode),
            eq(skus.lifecycleStatus, "ACTIVE"),
            eq(skus.saleStatus, "SELLABLE"),
            isNull(skus.archivedAt),
          ),
        )
        .for("share")
        .limit(1);
      if (!sku) {
        throw new ImportPreviewError(
          "SKU_NOT_AVAILABLE",
          "SKU 不存在、已下架或不可售",
        );
      }
      try {
        await resolveUnitPrice(tx, { skuId: sku.id });
      } catch {
        throw new ImportPreviewError(
          "SKU_NOT_AVAILABLE",
          "SKU 暂无有效拿货价，不能用于本次订单",
        );
      }
      resolvedSkuId = sku.id;
    }
    if (fulfillmentMode === "SYSTEM_SKU" && !resolvedSkuId) {
      throw new ImportPreviewError(
        "SKU_NOT_AVAILABLE",
        "请精确填写一个可售系统 SKU",
      );
    }

    let aiSuggestion:
      | { candidates: unknown; id: string; rowRevision: number }
      | undefined;
    if (input.aiSuggestionId) {
      if (
        fulfillmentMode !== "SYSTEM_SKU" ||
        row.status !== "UNKNOWN_SKU" ||
        !resolvedSkuId
      ) {
        throw new ImportPreviewError(
          "AI_SUGGESTION_INVALID",
          "该智能建议已失效，请重新选择",
        );
      }
      const [suggestion] = await tx
        .select({
          candidates: aiSkuMatchSuggestions.candidates,
          id: aiSkuMatchSuggestions.id,
          rowRevision: aiSkuMatchSuggestions.rowRevision,
        })
        .from(aiSkuMatchSuggestions)
        .where(
          and(
            eq(aiSkuMatchSuggestions.id, input.aiSuggestionId),
            eq(aiSkuMatchSuggestions.customerId, input.customerId),
            eq(aiSkuMatchSuggestions.batchId, batch.id),
            eq(aiSkuMatchSuggestions.rowId, row.id),
            eq(aiSkuMatchSuggestions.decision, "PENDING"),
            gt(aiSkuMatchSuggestions.expiresAt, now),
          ),
        )
        .for("update")
        .limit(1);
      const includesResolvedSku =
        suggestion &&
        Array.isArray(suggestion.candidates) &&
        suggestion.candidates.some(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            "skuId" in candidate &&
            candidate.skuId === resolvedSkuId,
        );
      if (
        !suggestion ||
        suggestion.rowRevision !== input.expectedRevision ||
        !includesResolvedSku
      ) {
        throw new ImportPreviewError(
          "AI_SUGGESTION_INVALID",
          "该智能建议已失效，请重新获取或手工填写",
        );
      }
      aiSuggestion = suggestion;
    }

    if (
      row.effectiveQuantity === input.effectiveQuantity &&
      row.finalSkuCode === finalSkuCode &&
      row.fulfillmentMode === fulfillmentMode &&
      row.resolvedSkuId === resolvedSkuId &&
      !aiSuggestion
    ) {
      await revalidateBatchInventory(tx, batch.id, now);
      return;
    }

    const [updated] = await tx
      .update(orderImportRows)
      .set({
        effectiveQuantity: input.effectiveQuantity,
        errorCode: null,
        errorMessage: null,
        finalSkuCode,
        fulfillmentMode,
        resolutionMethod:
          fulfillmentMode === "CUSTOMER_SUPPLIED"
            ? "CUSTOMER_SUPPLIED"
            : aiSuggestion
              ? "AI_CONFIRMED"
              : "MANUAL_OVERRIDE",
        resolvedSkuId,
        revision: row.revision + 1,
        status: "READY",
        updatedAt: now,
      })
      .where(
        and(
          eq(orderImportRows.id, row.id),
          eq(orderImportRows.revision, input.expectedRevision),
        ),
      )
      .returning({ id: orderImportRows.id });
    if (!updated) {
      throw new ImportPreviewError(
        "IMPORT_ROW_CONFLICT",
        "该行已被其他操作更新，请刷新后重试",
      );
    }

    const inventoryOutcome = await revalidateBatchInventory(tx, batch.id, now);
    if (
      aiSuggestion &&
      resolvedSkuId &&
      inventoryOutcome.insufficientSkuIds.has(resolvedSkuId)
    ) {
      throw new ImportPreviewError(
        "INSUFFICIENT_STOCK",
        "智能建议对应 SKU 的库存已变化，请重新选择",
      );
    }
    if (aiSuggestion && resolvedSkuId) {
      const [accepted] = await tx
        .update(aiSkuMatchSuggestions)
        .set({
          acceptedSkuId: resolvedSkuId,
          decidedAt: now,
          decision: "ACCEPTED",
        })
        .where(
          and(
            eq(aiSkuMatchSuggestions.id, aiSuggestion.id),
            eq(aiSkuMatchSuggestions.decision, "PENDING"),
          ),
        )
        .returning({ id: aiSkuMatchSuggestions.id });
      if (!accepted) {
        throw new ImportPreviewError(
          "AI_SUGGESTION_INVALID",
          "该智能建议已被处理，请刷新后重试",
        );
      }
      await tx.insert(auditLogs).values({
        action: "AI_SKU_MATCH_SUGGESTION_ACCEPTED",
        actorId: input.actorUserId,
        actorType: "CUSTOMER",
        afterJson: { decision: "ACCEPTED", skuId: resolvedSkuId },
        beforeJson: { decision: "PENDING" },
        entityId: aiSuggestion.id,
        entityType: "AI_SKU_MATCH_SUGGESTION",
        reason: "客户确认智能 SKU 建议并通过现有库存与价格校验",
      });
    }
    await tx.insert(auditLogs).values({
      action: "TEMU_IMPORT_ROW_OVERRIDDEN",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        effectiveQuantity: input.effectiveQuantity,
        fulfillmentMode: row.fulfillmentMode,
        resolvedSkuId,
        revision: row.revision + 1,
      },
      beforeJson: {
        effectiveQuantity: row.effectiveQuantity,
        resolvedSkuId: row.resolvedSkuId,
        revision: row.revision,
      },
      entityId: row.id,
      entityType: "ORDER_IMPORT_ROW",
      reason: "客户在提交前修正最终 SKU 或实际发货数量",
    });
  });

  if (transactionOutcome?.kind === "EXPIRED") {
    throw new ImportPreviewError("PREVIEW_EXPIRED", "导入预览已过期，请重新上传");
  }

  const preview = await getCustomerImportPreview(input.customerId, input.batchId);
  const result = preview.rows.find((row) => row.id === input.rowId);
  if (!result) {
    throw new ImportPreviewError(
      "IMPORT_ROW_NOT_FOUND",
      "找不到更新后的导入明细行",
    );
  }
  return result;
}

type StoredPreviewRow = Omit<
  ImportPreviewRowView,
  "fulfillmentItems" | "resolvedSku" | "siblingCandidates"
> & {
  additionalItems: Array<{
    effectiveQuantity: number;
    finalSkuCode: string;
    fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
    id: string;
    position: number;
    resolvedSkuId: string | null;
  }>;
  finalSkuCode: string | null;
  resolvedSkuId: string | null;
};

async function enrichPreviewRows(
  tx: Pick<DbTransaction, "select">,
  rows: StoredPreviewRow[],
): Promise<ImportPreviewRowView[]> {
  const lookupCodes = [
    ...new Set(
      rows.flatMap((row) => {
        if (row.fulfillmentMode !== "SYSTEM_SKU" || !row.externalSku) return [];
        try {
          return deriveImportSkuResolution(row.externalSku).lookupCandidates;
        } catch {
          return [];
        }
      }),
    ),
  ];
  const resolvedIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.resolvedSkuId ? [row.resolvedSkuId] : []),
        ...row.additionalItems.flatMap((item) =>
          item.resolvedSkuId ? [item.resolvedSkuId] : [],
        ),
      ]),
    ),
  ];
  const anchorConditions = [
    ...(resolvedIds.length > 0 ? [inArray(skus.id, resolvedIds)] : []),
    ...(lookupCodes.length > 0 ? [inArray(skus.skuCode, lookupCodes)] : []),
  ];
  const anchors =
    anchorConditions.length === 0
      ? []
      : await tx
          .select({
            cargoUnitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
            id: skus.id,
            name: skus.name,
            productId: skus.productId,
            skuCode: skus.skuCode,
          })
          .from(skus)
          .where(or(...anchorConditions));
  const anchorById = new Map(anchors.map((sku) => [sku.id, sku]));
  const anchorByCode = new Map(anchors.map((sku) => [sku.skuCode, sku]));
  const productIds = [...new Set(anchors.map((sku) => sku.productId))];
  const siblings =
    productIds.length === 0
      ? []
      : await tx
          .select({ id: skus.id, name: skus.name, productId: skus.productId, skuCode: skus.skuCode })
          .from(skus)
          .where(
            and(
              inArray(skus.productId, productIds),
              eq(skus.lifecycleStatus, "ACTIVE"),
              eq(skus.saleStatus, "SELLABLE"),
              isNull(skus.archivedAt),
            ),
          )
          .orderBy(asc(skus.skuCode));
  const siblingIds = siblings.map((sku) => sku.id);
  const [balances, reservations] = await Promise.all([
    siblingIds.length === 0
      ? []
      : tx
          .select({ skuId: inventoryBalances.skuId, total: inventoryBalances.totalQuantity })
          .from(inventoryBalances)
          .where(inArray(inventoryBalances.skuId, siblingIds)),
    siblingIds.length === 0
      ? []
      : tx
          .select({
            quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`.mapWith(Number),
            skuId: inventoryReservations.skuId,
          })
          .from(inventoryReservations)
          .where(
            and(
              inArray(inventoryReservations.skuId, siblingIds),
              eq(inventoryReservations.status, "ACTIVE"),
            ),
          )
          .groupBy(inventoryReservations.skuId),
  ]);
  const totalBySku = new Map(balances.map((row) => [row.skuId, row.total]));
  const reservedBySku = new Map(
    reservations.map((row) => [row.skuId, row.quantity]),
  );
  const availableQuantityFor = (skuId: string | null) =>
    skuId
      ? Math.max(
          (totalBySku.get(skuId) ?? 0) - (reservedBySku.get(skuId) ?? 0),
          0,
        )
      : null;
  const siblingsByProduct = new Map<
    string,
    ImportPreviewRowView["siblingCandidates"]
  >();
  for (const sibling of siblings) {
    const candidates = siblingsByProduct.get(sibling.productId) ?? [];
    candidates.push({
      availableQuantity: Math.max(
        (totalBySku.get(sibling.id) ?? 0) - (reservedBySku.get(sibling.id) ?? 0),
        0,
      ),
      id: sibling.id,
      name: sibling.name,
      skuCode: sibling.skuCode,
    });
    siblingsByProduct.set(sibling.productId, candidates);
  }

  return rows.map(({ additionalItems, resolvedSkuId, ...row }) => {
    const resolvedSku = resolvedSkuId ? (anchorById.get(resolvedSkuId) ?? null) : null;
    let anchor = resolvedSku;
    if (!anchor && row.externalSku) {
      try {
        anchor = deriveImportSkuResolution(row.externalSku).lookupCandidates
          .map((code) => anchorByCode.get(code))
          .find((candidate) => candidate !== undefined) ?? null;
      } catch {
        anchor = null;
      }
    }
    return {
      ...row,
      fulfillmentItems: [
        ...(row.effectiveQuantity && (resolvedSku || row.finalSkuCode)
          ? [
              {
                availableQuantity: availableQuantityFor(resolvedSku?.id ?? null),
                effectiveQuantity: row.effectiveQuantity,
                fulfillmentMode: row.fulfillmentMode,
                id: row.id,
                isPrimary: true,
                position: 1,
                resolvedSkuId: resolvedSku?.id ?? null,
                skuCode:
                  row.fulfillmentMode === "CUSTOMER_SUPPLIED"
                    ? row.finalSkuCode!
                    : resolvedSku!.skuCode,
                unitPriceMilliYuan:
                  row.fulfillmentMode === "SYSTEM_SKU"
                    ? resolvedSku!.cargoUnitPriceMilliYuan
                    : null,
              },
            ]
          : []),
        ...additionalItems.map((item) => ({
          availableQuantity: availableQuantityFor(item.resolvedSkuId),
          effectiveQuantity: item.effectiveQuantity,
          fulfillmentMode: item.fulfillmentMode,
          id: item.id,
          isPrimary: false,
          position: item.position,
          resolvedSkuId: item.resolvedSkuId,
          skuCode:
            item.fulfillmentMode === "CUSTOMER_SUPPLIED"
              ? item.finalSkuCode
              : (anchorById.get(item.resolvedSkuId!)?.skuCode ?? item.finalSkuCode),
          unitPriceMilliYuan:
            item.fulfillmentMode === "SYSTEM_SKU"
              ? (anchorById.get(item.resolvedSkuId!)?.cargoUnitPriceMilliYuan ?? null)
              : null,
        })),
      ],
      resolvedSku: resolvedSku
        ? {
            id: resolvedSku.id,
            name: resolvedSku.name,
            skuCode: resolvedSku.skuCode,
            unitPriceMilliYuan: resolvedSku.cargoUnitPriceMilliYuan,
          }
        : null,
      siblingCandidates: anchor
        ? (siblingsByProduct.get(anchor.productId) ?? [])
        : [],
    };
  });
}
