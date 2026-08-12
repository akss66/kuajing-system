import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bulkImportStoreGroups,
  inventoryBalances,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  orderLines,
} from "@/db/schema";

import {
  findCrossStoreConflicts,
  findGroupsAffectedByShortage,
} from "./conflicts";
import { getBulkDraft, type BulkDraftStatus } from "./draft-service";

const INVENTORY_QUERY_CHUNK_SIZE = 1_000;

export type BulkDraftValidationStatus =
  | "SUBMITTABLE"
  | "BLOCKED_CROSS_STORE"
  | "BLOCKED_UNKNOWN_SKU"
  | "BLOCKED_INVALID"
  | "BLOCKED_INVENTORY"
  | "EMPTY"
  | "ALREADY_SUBMITTED"
  | "EXPIRED";

export type BulkDraftValidationErrorCode =
  | "DRAFT_EXPIRED"
  | "FILE_EXPIRED"
  | "GROUP_ALREADY_SUBMITTED"
  | "CROSS_STORE_FILE"
  | "CROSS_STORE_SUB_ORDER"
  | "UNKNOWN_SKU"
  | "INVALID_ROW"
  | "INSUFFICIENT_STOCK"
  | "NO_VALID_ORDERS";

export type BulkDraftValidationGroupView = {
  deduplicatedOrderCount: number;
  errorCodes: BulkDraftValidationErrorCode[];
  existingOrderCount: number;
  fileCount: number;
  groupId: string;
  invalidRowCount: number;
  sameStoreDuplicateCount: number;
  status: BulkDraftValidationStatus;
  storeId: string;
  totalQuantity: number;
  totalRowCount: number;
  unknownSkuCount: number;
};

export type BulkDraftValidationView = {
  draftId: string;
  draftStatus: BulkDraftStatus;
  groups: Map<string, BulkDraftValidationGroupView>;
  shortageBySku: Map<
    string,
    { availableQuantity: number; requiredQuantity: number }
  >;
};

type LoadedRow = {
  externalSubOrderNo: string | null;
  quantity: number | null;
  resolvedSkuId: string | null;
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
};

type LoadedBatch = {
  createdAt: Date;
  expiresAt: Date;
  fileSha256: string;
  id: string;
  rows: LoadedRow[];
};

type GroupWork = {
  batches: LoadedBatch[];
  candidates: LoadedRow[];
  existingOrderCount: number;
  invalidRowCount: number;
  quantityBySku: Map<string, number>;
  sameStoreDuplicateCount: number;
  unknownSkuCount: number;
};

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function rowKey(storeId: string, externalSubOrderNo: string) {
  return `${storeId}\u0000${externalSubOrderNo}`;
}

function groupHasConflict(
  conflicts: ReadonlyMap<string, ReadonlySet<string>>,
  groupId: string,
) {
  for (const groupIds of conflicts.values()) {
    if (groupIds.has(groupId)) return true;
  }
  return false;
}

function validationStatus(input: {
  draftStatus: BulkDraftStatus;
  errorCodes: readonly BulkDraftValidationErrorCode[];
  groupStatus: "PREVIEW" | "SUBMITTED" | "EXPIRED" | "CANCELLED";
}): BulkDraftValidationStatus {
  if (input.draftStatus === "EXPIRED" || input.groupStatus === "EXPIRED") {
    return "EXPIRED";
  }
  if (input.groupStatus === "SUBMITTED") return "ALREADY_SUBMITTED";
  if (
    input.errorCodes.includes("CROSS_STORE_FILE") ||
    input.errorCodes.includes("CROSS_STORE_SUB_ORDER")
  ) {
    return "BLOCKED_CROSS_STORE";
  }
  if (input.errorCodes.includes("UNKNOWN_SKU")) {
    return "BLOCKED_UNKNOWN_SKU";
  }
  if (input.errorCodes.includes("INVALID_ROW")) return "BLOCKED_INVALID";
  if (input.errorCodes.includes("INSUFFICIENT_STOCK")) {
    return "BLOCKED_INVENTORY";
  }
  if (input.errorCodes.includes("NO_VALID_ORDERS")) return "EMPTY";
  return "SUBMITTABLE";
}

async function loadAvailableQuantities(skuIds: readonly string[]) {
  const availableBySku = new Map<string, number>();
  for (const skuChunk of chunks([...new Set(skuIds)].sort(), INVENTORY_QUERY_CHUNK_SIZE)) {
    const balances = await db
      .select({
        reservedQuantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`.mapWith(
          Number,
        ),
        skuId: inventoryBalances.skuId,
        totalQuantity: inventoryBalances.totalQuantity,
      })
      .from(inventoryBalances)
      .leftJoin(
        inventoryReservations,
        and(
          eq(inventoryReservations.skuId, inventoryBalances.skuId),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      )
      .where(inArray(inventoryBalances.skuId, skuChunk))
      .groupBy(inventoryBalances.skuId, inventoryBalances.totalQuantity);

    for (const balance of balances) {
      availableBySku.set(
        balance.skuId,
        Math.max(0, balance.totalQuantity - balance.reservedQuantity),
      );
    }
  }
  return availableBySku;
}

export async function validateBulkDraft(input: {
  customerId: string;
  draftId: string;
}): Promise<BulkDraftValidationView> {
  const draft = await getBulkDraft(input.customerId, input.draftId);
  const groupIds = draft.groups
    .filter((group) => group.status === "PREVIEW")
    .map((group) => group.id);
  const loadedGroups = new Map<string, GroupWork>(
    draft.groups.map((group) => [
      group.id,
      {
        batches: [],
        candidates: [],
        existingOrderCount: 0,
        invalidRowCount: 0,
        quantityBySku: new Map<string, number>(),
        sameStoreDuplicateCount: 0,
        unknownSkuCount: 0,
      },
    ]),
  );

  const storedRows =
    groupIds.length === 0
      ? []
      : await db
          .select({
            batchCreatedAt: orderImportBatches.createdAt,
            batchExpiresAt: orderImportBatches.expiresAt,
            batchId: orderImportBatches.id,
            externalSubOrderNo: orderImportRows.externalSubOrderNo,
            fileSha256: orderImportBatches.fileSha256,
            groupId: orderImportBatches.storeGroupId,
            quantity: orderImportRows.quantity,
            resolvedSkuId: orderImportRows.resolvedSkuId,
            rowId: orderImportRows.id,
            rowNumber: orderImportRows.rowNumber,
            rowStatus: orderImportRows.status,
          })
          .from(orderImportBatches)
          .leftJoin(
            orderImportRows,
            eq(orderImportRows.batchId, orderImportBatches.id),
          )
          .where(inArray(orderImportBatches.storeGroupId, groupIds));

  for (const row of storedRows) {
    if (!row.groupId) continue;
    const work = loadedGroups.get(row.groupId);
    if (!work) continue;
    let batch = work.batches.find((candidate) => candidate.id === row.batchId);
    if (!batch) {
      batch = {
        createdAt: row.batchCreatedAt,
        expiresAt: row.batchExpiresAt,
        fileSha256: row.fileSha256,
        id: row.batchId,
        rows: [],
      };
      work.batches.push(batch);
    }
    if (
      row.rowId &&
      row.rowNumber !== null &&
      row.rowStatus !== null
    ) {
      batch.rows.push({
        externalSubOrderNo: row.externalSubOrderNo,
        quantity: row.quantity,
        resolvedSkuId: row.resolvedSkuId,
        rowNumber: row.rowNumber,
        status: row.rowStatus,
      });
    }
  }

  const existingRows =
    groupIds.length === 0
      ? []
      : await db
          .select({
            externalSubOrderNo: orderLines.externalSubOrderNo,
            storeId: orderLines.storeId,
          })
          .from(orderLines)
          .innerJoin(
            bulkImportStoreGroups,
            and(
              eq(bulkImportStoreGroups.storeId, orderLines.storeId),
              eq(bulkImportStoreGroups.draftId, input.draftId),
              eq(bulkImportStoreGroups.customerId, input.customerId),
            ),
          )
          .innerJoin(
            orderImportBatches,
            eq(orderImportBatches.storeGroupId, bulkImportStoreGroups.id),
          )
          .innerJoin(
            orderImportRows,
            and(
              eq(orderImportRows.batchId, orderImportBatches.id),
              eq(
                orderImportRows.externalSubOrderNo,
                orderLines.externalSubOrderNo,
              ),
            ),
          )
          .where(inArray(bulkImportStoreGroups.id, groupIds));
  const existingOrderKeys = new Set(
    existingRows.flatMap((row) =>
      row.externalSubOrderNo
        ? [rowKey(row.storeId, row.externalSubOrderNo)]
        : [],
    ),
  );

  for (const group of draft.groups) {
    const work = loadedGroups.get(group.id)!;
    const rows = work.batches
      .sort(
        (first, second) =>
          first.createdAt.getTime() - second.createdAt.getTime() ||
          first.id.localeCompare(second.id),
      )
      .flatMap((batch) =>
        batch.rows.sort((first, second) => first.rowNumber - second.rowNumber),
      );
    work.unknownSkuCount = rows.filter(
      (row) => row.status === "UNKNOWN_SKU",
    ).length;
    work.invalidRowCount = rows.filter((row) => row.status === "INVALID").length;

    const firstBySubOrder = new Map<string, LoadedRow>();
    for (const row of rows) {
      if (!row.externalSubOrderNo) continue;
      if (firstBySubOrder.has(row.externalSubOrderNo)) {
        work.sameStoreDuplicateCount += 1;
      } else {
        firstBySubOrder.set(row.externalSubOrderNo, row);
      }
    }

    for (const row of firstBySubOrder.values()) {
      if (
        existingOrderKeys.has(rowKey(group.storeId, row.externalSubOrderNo!)) ||
        row.status === "DUPLICATE"
      ) {
        work.existingOrderCount += 1;
        continue;
      }
      if (row.status !== "READY") continue;
      if (
        !row.resolvedSkuId ||
        !row.quantity ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity <= 0
      ) {
        work.invalidRowCount += 1;
        continue;
      }
      work.candidates.push(row);
      work.quantityBySku.set(
        row.resolvedSkuId,
        (work.quantityBySku.get(row.resolvedSkuId) ?? 0) + row.quantity,
      );
    }
  }

  const crossStore = findCrossStoreConflicts(
    draft.groups.map((group) => {
      const work = loadedGroups.get(group.id)!;
      return {
        fileHashes: work.batches.map((batch) => batch.fileSha256),
        groupId: group.id,
        subOrderNos: work.batches.flatMap((batch) =>
          batch.rows.flatMap((row) =>
            row.externalSubOrderNo ? [row.externalSubOrderNo] : [],
          ),
        ),
      };
    }),
  );
  const stockGroups = draft.groups.map((group) => ({
    groupId: group.id,
    quantityBySku: loadedGroups.get(group.id)!.quantityBySku,
  }));
  const skuIds = stockGroups.flatMap((group) => [...group.quantityBySku.keys()]);
  const availableBySku = await loadAvailableQuantities(skuIds);
  const stock = findGroupsAffectedByShortage(stockGroups, availableBySku);

  const groups = new Map<string, BulkDraftValidationGroupView>();
  for (const group of draft.groups) {
    const work = loadedGroups.get(group.id)!;
    const errorCodes: BulkDraftValidationErrorCode[] = [];
    if (draft.status === "EXPIRED") {
      errorCodes.push("DRAFT_EXPIRED");
    } else {
      if (
        group.status === "EXPIRED" ||
        work.batches.some((batch) => batch.expiresAt.getTime() <= Date.now())
      ) {
        errorCodes.push("FILE_EXPIRED");
      }
      if (group.status === "SUBMITTED") {
        errorCodes.push("GROUP_ALREADY_SUBMITTED");
      }
      if (groupHasConflict(crossStore.fileHashConflicts, group.id)) {
        errorCodes.push("CROSS_STORE_FILE");
      }
      if (groupHasConflict(crossStore.subOrderConflicts, group.id)) {
        errorCodes.push("CROSS_STORE_SUB_ORDER");
      }
      if (work.unknownSkuCount > 0) errorCodes.push("UNKNOWN_SKU");
      if (work.invalidRowCount > 0) errorCodes.push("INVALID_ROW");
      if (stock.blockedGroupIds.has(group.id)) {
        errorCodes.push("INSUFFICIENT_STOCK");
      }
      if (work.candidates.length === 0 && errorCodes.length === 0) {
        errorCodes.push("NO_VALID_ORDERS");
      }
    }

    groups.set(group.id, {
      deduplicatedOrderCount: work.candidates.length,
      errorCodes,
      existingOrderCount: work.existingOrderCount,
      fileCount: work.batches.length,
      groupId: group.id,
      invalidRowCount: work.invalidRowCount,
      sameStoreDuplicateCount: work.sameStoreDuplicateCount,
      status: validationStatus({
        draftStatus: draft.status,
        errorCodes,
        groupStatus: group.status,
      }),
      storeId: group.storeId,
      totalQuantity: [...work.quantityBySku.values()].reduce(
        (total, quantity) => total + quantity,
        0,
      ),
      totalRowCount: work.batches.reduce(
        (total, batch) => total + batch.rows.length,
        0,
      ),
      unknownSkuCount: work.unknownSkuCount,
    });
  }

  return {
    draftId: draft.id,
    draftStatus: draft.status,
    groups,
    shortageBySku: stock.shortageBySku,
  };
}
