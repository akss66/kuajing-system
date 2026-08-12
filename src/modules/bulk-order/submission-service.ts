import { createHash } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  bulkImportDrafts,
  bulkImportStoreGroups,
  bulkSubmissionRequests,
  fulfillmentOrderImportBatches,
  fulfillmentOrders,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  orderLines,
  orderShipments,
  settlementBatchOrders,
  settlementBatches,
  skus,
  stores,
} from "@/db/schema";
import { resolveUnitPrice } from "@/modules/catalog/pricing";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { reserveInventoryForGroups } from "@/modules/inventory/service";
import {
  createFulfillmentOrderNumber,
  UNPAID_ORDER_LOCK_MS,
} from "@/modules/orders/submission";
import {
  applyBulkSettlementWallet,
  lockWalletForBulkSettlement,
} from "@/modules/wallet/service";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import { allocateWalletFen } from "./allocation";
import { findCrossStoreConflicts } from "./conflicts";

export type SubmitBulkDraftInput = {
  actorUserId: string;
  customerId: string;
  draftId: string;
  idempotencyKey: string;
  requestedWalletFen: number;
  selectedGroupIds: readonly string[];
};

export type BulkSubmissionFailureStatus =
  | "STOCK_CHANGED"
  | "DUPLICATE_CHANGED"
  | "CROSS_STORE_CONFLICT"
  | "EXPIRED"
  | "INVALID";

export type BulkCreatedOrder = {
  groupId: string;
  orderId: string;
  orderNumber: string;
  status: "ORDER_CREATED";
  storeId: string;
  totalAmountFen: number;
  totalPackageCount: number;
  totalQuantity: number;
};

export type BulkFailedGroup = {
  groupId: string;
  status: BulkSubmissionFailureStatus;
  storeId: string;
};

export type BulkSubmissionResult = {
  createdOrders: BulkCreatedOrder[];
  failedGroups: BulkFailedGroup[];
  groupResults: Array<BulkCreatedOrder | BulkFailedGroup>;
  settlementBatchId: string | null;
};

export type BulkSubmissionErrorCode =
  | "DRAFT_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_INPUT"
  | "INVALID_STATE";

export class BulkSubmissionError extends Error {
  constructor(
    public readonly code: BulkSubmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BulkSubmissionError";
  }
}

type LockedDraft = {
  expiresAt: Date;
  id: string;
  status: "DRAFT" | "PARTIALLY_SUBMITTED" | "COMPLETED" | "EXPIRED";
};

type StoreGroup = {
  id: string;
  status: "PREVIEW" | "SUBMITTED" | "EXPIRED" | "CANCELLED";
  storeId: string;
};

type LoadedBatch = {
  createdAt: Date;
  duplicateRows: number;
  expiresAt: Date;
  fileSha256: string;
  groupId: string;
  id: string;
  invalidRows: number;
  status: "PREVIEW" | "SUBMITTED" | "EXPIRED";
  storeId: string;
  unknownSkuRows: number;
};

type LoadedRow = {
  batchId: string;
  externalOrderNo: string | null;
  externalSku: string | null;
  externalSubOrderNo: string | null;
  id: string;
  quantity: number | null;
  recipientPayloadEncrypted: string | null;
  resolvedSkuId: string | null;
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
};

type ReadyRow = LoadedRow & {
  externalOrderNo: string;
  externalSku: string;
  externalSubOrderNo: string;
  quantity: number;
  recipientPayloadEncrypted: string;
  resolvedSkuId: string;
};

type PreparedGroup = {
  batches: LoadedBatch[];
  group: StoreGroup;
  orderId: string;
  orderNumber: string;
  quantityBySku: Map<string, number>;
  rows: ReadyRow[];
  totalAmountFen: number;
  totalPackageCount: number;
  totalQuantity: number;
};

const SUBMISSION_AUDIT_ACTION = "BULK_ORDER_SUBMISSION_COMPLETED";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertInput(input: SubmitBulkDraftInput) {
  if (
    !input.actorUserId.trim() ||
    !input.customerId.trim() ||
    !input.draftId.trim() ||
    !input.idempotencyKey.trim() ||
    input.selectedGroupIds.length === 0
  ) {
    throw new BulkSubmissionError("INVALID_INPUT", "批量提交参数不完整");
  }
  if (
    !Number.isSafeInteger(input.requestedWalletFen) ||
    input.requestedWalletFen < 0
  ) {
    throw new BulkSubmissionError(
      "INVALID_INPUT",
      "余额抵扣金额必须是非负整数分",
    );
  }
  if (input.selectedGroupIds.some((groupId) => !groupId.trim())) {
    throw new BulkSubmissionError("INVALID_INPUT", "店铺分组 ID 不能为空");
  }
}

function safeAdd(first: number, second: number) {
  const result = first + second;
  if (
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > 2_147_483_647
  ) {
    throw new BulkSubmissionError("INVALID_STATE", "订单金额或数量超出系统范围");
  }
  return result;
}

function safeMultiply(first: number, second: number) {
  const result = first * second;
  if (
    !Number.isSafeInteger(result) ||
    result < 0 ||
    result > 2_147_483_647
  ) {
    throw new BulkSubmissionError("INVALID_STATE", "订单金额超出系统范围");
  }
  return result;
}

function settlementNumber(now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
  })
    .format(now)
    .replaceAll("-", "");
  return `SET-${date}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
}

function isStoredResult(value: unknown): value is BulkSubmissionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BulkSubmissionResult>;
  return (
    Array.isArray(candidate.createdOrders) &&
    Array.isArray(candidate.failedGroups) &&
    Array.isArray(candidate.groupResults) &&
    (candidate.settlementBatchId === null ||
      typeof candidate.settlementBatchId === "string")
  );
}

async function lockOwnedDraft(
  tx: DbTransaction,
  input: Pick<SubmitBulkDraftInput, "customerId" | "draftId">,
): Promise<LockedDraft> {
  const [draft] = await tx
    .select({
      expiresAt: bulkImportDrafts.expiresAt,
      id: bulkImportDrafts.id,
      status: bulkImportDrafts.status,
    })
    .from(bulkImportDrafts)
    .where(
      and(
        eq(bulkImportDrafts.id, input.draftId),
        eq(bulkImportDrafts.customerId, input.customerId),
      ),
    )
    .for("update")
    .limit(1);
  if (!draft) {
    throw new BulkSubmissionError("DRAFT_NOT_FOUND", "找不到该批量导入草稿");
  }
  return draft;
}

async function findIdempotentResult(
  tx: DbTransaction,
  input: {
    customerId: string;
    idempotencyKey: string;
    payloadDigest: string;
  },
) {
  const [record] = await tx
    .select({
      payloadDigest: bulkSubmissionRequests.payloadDigest,
      resultJson: bulkSubmissionRequests.resultJson,
    })
    .from(bulkSubmissionRequests)
    .where(
      and(
        eq(bulkSubmissionRequests.customerId, input.customerId),
        eq(bulkSubmissionRequests.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!record) return null;
  if (record.payloadDigest !== input.payloadDigest) {
    throw new BulkSubmissionError(
      "IDEMPOTENCY_KEY_REUSED",
      "该幂等键已用于不同的批量提交请求",
    );
  }
  if (!isStoredResult(record.resultJson)) {
    throw new BulkSubmissionError("INVALID_STATE", "批量提交幂等记录损坏");
  }
  return record.resultJson;
}

function rowsForGroup(
  group: StoreGroup,
  batches: readonly LoadedBatch[],
  rows: readonly LoadedRow[],
) {
  const groupBatches = batches
    .filter((batch) => batch.groupId === group.id)
    .sort(
      (first, second) =>
        first.createdAt.getTime() - second.createdAt.getTime() ||
        first.id.localeCompare(second.id),
    );
  const batchOrder = new Map(
    groupBatches.map((batch, index) => [batch.id, index]),
  );
  const groupRows = rows
    .filter((row) => batchOrder.has(row.batchId))
    .sort(
      (first, second) =>
        batchOrder.get(first.batchId)! - batchOrder.get(second.batchId)! ||
        first.rowNumber - second.rowNumber ||
        first.id.localeCompare(second.id),
    );
  return { groupBatches, groupRows };
}

function candidateRows(rows: readonly LoadedRow[]) {
  const firstBySubOrder = new Map<string, LoadedRow>();
  for (const row of rows) {
    if (!row.externalSubOrderNo || firstBySubOrder.has(row.externalSubOrderNo)) {
      continue;
    }
    firstBySubOrder.set(row.externalSubOrderNo, row);
  }
  return [...firstBySubOrder.values()].filter(
    (row) => row.status !== "DUPLICATE",
  );
}

function isReadyRow(row: LoadedRow): row is ReadyRow {
  return (
    row.status === "READY" &&
    Boolean(row.externalOrderNo) &&
    Boolean(row.externalSku) &&
    Boolean(row.externalSubOrderNo) &&
    Boolean(row.recipientPayloadEncrypted) &&
    Boolean(row.resolvedSkuId) &&
    Number.isSafeInteger(row.quantity) &&
    (row.quantity ?? 0) > 0
  );
}

function orderedResult(input: {
  createdOrders: BulkCreatedOrder[];
  failedGroups: BulkFailedGroup[];
  settlementBatchId: string | null;
}): BulkSubmissionResult {
  const createdOrders = input.createdOrders.sort((first, second) =>
    first.groupId.localeCompare(second.groupId),
  );
  const failedGroups = input.failedGroups.sort((first, second) =>
    first.groupId.localeCompare(second.groupId),
  );
  return {
    createdOrders,
    failedGroups,
    groupResults: [...createdOrders, ...failedGroups].sort((first, second) =>
      first.groupId.localeCompare(second.groupId),
    ),
    settlementBatchId: input.settlementBatchId,
  };
}

async function lockSubmissionScope(
  tx: DbTransaction,
  scopeDigest: string,
) {
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`bulk-submission:${scopeDigest}`}, 0)
    )
  `);
}

async function lockSubmissionConflicts(
  tx: DbTransaction,
  input: {
    customerId: string;
    fileHashes: readonly string[];
    subOrderNos: readonly string[];
  },
) {
  const keys = [
    ...input.fileHashes.map(
      (fileHash) => `file:${input.customerId}:${fileHash}`,
    ),
    ...input.subOrderNos.map(
      (subOrderNo) => `sub-order:${input.customerId}:${subOrderNo}`,
    ),
  ];
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`bulk-submission-conflict:${key}`}, 0)
      )
    `);
  }
}

async function createSubmissionSettlement(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    createdOrders: readonly BulkCreatedOrder[];
    customerId: string;
    lockExpiresAt: Date;
    now: Date;
    requestedWalletFen: number;
    scopeDigest: string;
  },
) {
  if (input.createdOrders.length === 0) return null;
  const totalAmountFen = input.createdOrders.reduce(
    (total, order) => safeAdd(total, order.totalAmountFen),
    0,
  );
  const wallet = await lockWalletForBulkSettlement(tx, input.customerId);
  const actualWalletFen = Math.min(
    input.requestedWalletFen,
    totalAmountFen,
    wallet.availableFen,
  );
  const allocations = allocateWalletFen(
    input.createdOrders.map((order) => ({
      orderId: order.orderId,
      totalAmountFen: order.totalAmountFen,
    })),
    actualWalletFen,
  );
  const walletAmountFen = allocations.reduce(
    (total, allocation) => safeAdd(total, allocation.walletFen),
    0,
  );
  const isPureWallet = walletAmountFen === totalAmountFen;
  const [settlement] = await tx
    .insert(settlementBatches)
    .values({
      batchNumber: settlementNumber(input.now),
      customerId: input.customerId,
      idempotencyKey: `bulk:${input.scopeDigest}`,
      offlineAmountFen: totalAmountFen - walletAmountFen,
      paidAt: isPureWallet ? input.now : null,
      paymentDueAt: input.lockExpiresAt,
      status: isPureWallet ? "PAID" : "PENDING_PAYMENT",
      totalAmountFen,
      walletAmountFen,
    })
    .returning({ id: settlementBatches.id });
  const createdById = new Map(
    input.createdOrders.map((order) => [order.orderId, order]),
  );
  await tx.insert(settlementBatchOrders).values(
    allocations.map((allocation) => ({
      customerId: input.customerId,
      offlineAmountFen: allocation.offlineFen,
      orderId: allocation.orderId,
      settlementBatchId: settlement.id,
      totalAmountFen: createdById.get(allocation.orderId)!.totalAmountFen,
      walletAmountFen: allocation.walletFen,
    })),
  );
  await applyBulkSettlementWallet(tx, {
    actorUserId: input.actorUserId,
    allocations,
    customerId: input.customerId,
    now: input.now,
    settlementBatchId: settlement.id,
    snapshot: wallet,
    totalAmountFen,
    walletAmountFen,
  });
  if (isPureWallet) {
    const orderIds = input.createdOrders.map((order) => order.orderId);
    await tx
      .update(fulfillmentOrders)
      .set({
        lockExpiresAt: null,
        paidAt: input.now,
        paymentMode: "WALLET",
        status: "PAID_PENDING_FULFILLMENT",
        updatedAt: input.now,
      })
      .where(inArray(fulfillmentOrders.id, orderIds));
    await tx
      .update(inventoryReservations)
      .set({ expiresAt: null, updatedAt: input.now })
      .where(
        and(
          eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
          inArray(inventoryReservations.referenceId, orderIds),
          eq(inventoryReservations.status, "ACTIVE"),
        ),
      );
  }
  return settlement.id;
}

async function updateDraftAfterSubmission(
  tx: DbTransaction,
  input: {
    createdOrderCount: number;
    draftExpired: boolean;
    draftId: string;
    now: Date;
  },
) {
  if (input.draftExpired) {
    await tx
      .update(bulkImportDrafts)
      .set({ status: "EXPIRED", updatedAt: input.now })
      .where(eq(bulkImportDrafts.id, input.draftId));
    return;
  }
  if (input.createdOrderCount === 0) return;
  const [remaining] = await tx
    .select({ id: bulkImportStoreGroups.id })
    .from(bulkImportStoreGroups)
    .where(
      and(
        eq(bulkImportStoreGroups.draftId, input.draftId),
        eq(bulkImportStoreGroups.status, "PREVIEW"),
      ),
    )
    .limit(1);
  await tx
    .update(bulkImportDrafts)
    .set({
      status: remaining ? "PARTIALLY_SUBMITTED" : "COMPLETED",
      updatedAt: input.now,
      version: sql`${bulkImportDrafts.version} + 1`,
    })
    .where(eq(bulkImportDrafts.id, input.draftId));
}

async function recordIdempotentResult(
  tx: DbTransaction,
  input: {
    actorUserId: string;
    customerId: string;
    draftId: string;
    idempotencyKey: string;
    result: BulkSubmissionResult;
    scopeDigest: string;
    settlementBatchId: string | null;
    selectedGroupCount: number;
  },
) {
  await tx
    .update(bulkSubmissionRequests)
    .set({
      resultJson: input.result,
      settlementBatchId: input.settlementBatchId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bulkSubmissionRequests.customerId, input.customerId),
        eq(bulkSubmissionRequests.idempotencyKey, input.idempotencyKey),
      ),
    );
  await tx.insert(auditLogs).values({
    action: SUBMISSION_AUDIT_ACTION,
    actorId: input.actorUserId,
    actorType: "CUSTOMER",
    afterJson: {
      createdOrderCount: input.result.createdOrders.length,
      failedGroupCount: input.result.failedGroups.length,
      settlementBatchId: input.settlementBatchId,
    },
    beforeJson: {
      draftId: input.draftId,
      selectedGroupCount: input.selectedGroupCount,
    },
    entityId: input.scopeDigest,
    entityType: "BULK_SUBMISSION",
    reason: "记录批量提交完成结果",
  });
}

export async function submitBulkDraft(
  input: SubmitBulkDraftInput,
): Promise<BulkSubmissionResult> {
  assertInput(input);
  const selectedGroupIds = [...new Set(input.selectedGroupIds)].sort();
  const idempotencyKey = input.idempotencyKey.trim();
  const scopeDigest = digest(`${input.customerId}\u0000${idempotencyKey}`);
  const payloadDigest = digest(
    JSON.stringify({
      draftId: input.draftId,
      requestedWalletFen: input.requestedWalletFen,
      selectedGroupIds,
    }),
  );

  return db.transaction(async (tx) => {
    await lockSubmissionScope(tx, scopeDigest);
    const existing = await findIdempotentResult(tx, {
      customerId: input.customerId,
      idempotencyKey,
      payloadDigest,
    });
    if (existing) return existing;
    const draft = await lockOwnedDraft(tx, input);
    await tx.insert(bulkSubmissionRequests).values({
      customerId: input.customerId,
      draftId: draft.id,
      idempotencyKey,
      payloadDigest,
    });

    const selectedGroups = await tx
      .select({
        id: bulkImportStoreGroups.id,
        status: bulkImportStoreGroups.status,
        storeId: bulkImportStoreGroups.storeId,
      })
      .from(bulkImportStoreGroups)
      .where(
        and(
          eq(bulkImportStoreGroups.draftId, draft.id),
          eq(bulkImportStoreGroups.customerId, input.customerId),
          inArray(bulkImportStoreGroups.id, selectedGroupIds),
        ),
      )
      .orderBy(asc(bulkImportStoreGroups.id))
      .for("update");
    if (selectedGroups.length !== selectedGroupIds.length) {
      throw new BulkSubmissionError(
        "GROUP_NOT_FOUND",
        "所选店铺分组不属于当前客户草稿",
      );
    }

    const allGroups = await tx
      .select({
        id: bulkImportStoreGroups.id,
        status: bulkImportStoreGroups.status,
        storeId: bulkImportStoreGroups.storeId,
      })
      .from(bulkImportStoreGroups)
      .where(
        and(
          eq(bulkImportStoreGroups.draftId, draft.id),
          eq(bulkImportStoreGroups.customerId, input.customerId),
        ),
      );
    const allGroupIds = allGroups.map((group) => group.id);
    const loadedBatches =
      allGroupIds.length === 0
        ? []
        : await tx
            .select({
              createdAt: orderImportBatches.createdAt,
              duplicateRows: orderImportBatches.duplicateRows,
              expiresAt: orderImportBatches.expiresAt,
              fileSha256: orderImportBatches.fileSha256,
              groupId: orderImportBatches.storeGroupId,
              id: orderImportBatches.id,
              invalidRows: orderImportBatches.invalidRows,
              status: orderImportBatches.status,
              storeId: orderImportBatches.storeId,
              unknownSkuRows: orderImportBatches.unknownSkuRows,
            })
            .from(orderImportBatches)
            .where(inArray(orderImportBatches.storeGroupId, allGroupIds))
            .orderBy(asc(orderImportBatches.id));
    const batchIds = loadedBatches.map((batch) => batch.id);
    if (batchIds.length > 0) {
      await tx
        .select({ id: orderImportBatches.id })
        .from(orderImportBatches)
        .where(
          inArray(
            orderImportBatches.id,
            loadedBatches
              .filter((batch) => selectedGroupIds.includes(batch.groupId!))
              .map((batch) => batch.id),
          ),
        )
        .orderBy(asc(orderImportBatches.id))
        .for("update");
    }
    const loadedRows =
      batchIds.length === 0
        ? []
        : await tx
            .select({
              batchId: orderImportRows.batchId,
              externalOrderNo: orderImportRows.externalOrderNo,
              externalSku: orderImportRows.externalSku,
              externalSubOrderNo: orderImportRows.externalSubOrderNo,
              id: orderImportRows.id,
              quantity: orderImportRows.quantity,
              recipientPayloadEncrypted:
                orderImportRows.recipientPayloadEncrypted,
              resolvedSkuId: orderImportRows.resolvedSkuId,
              rowNumber: orderImportRows.rowNumber,
              status: orderImportRows.status,
            })
            .from(orderImportRows)
            .where(inArray(orderImportRows.batchId, batchIds))
            .orderBy(asc(orderImportRows.id));

    const selectedStores = await tx
      .select({ id: stores.id, status: stores.status })
      .from(stores)
      .where(
        and(
          eq(stores.customerId, input.customerId),
          inArray(
            stores.id,
            selectedGroups.map((group) => group.storeId),
          ),
        ),
      );
    const storeStatus = new Map(
      selectedStores.map((store) => [store.id, store.status]),
    );
    const crossStore = findCrossStoreConflicts(
      allGroups.map((group) => {
        const { groupBatches, groupRows } = rowsForGroup(
          group,
          loadedBatches as LoadedBatch[],
          loadedRows,
        );
        return {
          fileHashes: groupBatches.map((batch) => batch.fileSha256),
          groupId: group.id,
          subOrderNos: groupRows.flatMap((row) =>
            row.externalSubOrderNo ? [row.externalSubOrderNo] : [],
          ),
        };
      }),
    );

    const failedByGroup = new Map<string, BulkSubmissionFailureStatus>();
    const candidateByGroup = new Map<
      string,
      { batches: LoadedBatch[]; rows: ReadyRow[] }
    >();
    const now = new Date();
    const draftExpired =
      draft.status === "EXPIRED" || draft.expiresAt.getTime() <= now.getTime();
    for (const group of selectedGroups) {
      const { groupBatches, groupRows } = rowsForGroup(
        group,
        loadedBatches as LoadedBatch[],
        loadedRows,
      );
      if (draftExpired) {
        failedByGroup.set(group.id, "EXPIRED");
        continue;
      }
      if (
        draft.status === "COMPLETED" ||
        group.status !== "PREVIEW" ||
        storeStatus.get(group.storeId) !== "ACTIVE"
      ) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      if (
        crossStore.blockedGroupIds.has(group.id) ||
        groupBatches.some((batch) => batch.storeId !== group.storeId)
      ) {
        failedByGroup.set(group.id, "CROSS_STORE_CONFLICT");
        continue;
      }
      if (
        groupBatches.length === 0 ||
        groupBatches.some(
          (batch) =>
            batch.status === "EXPIRED" ||
            batch.expiresAt.getTime() <= now.getTime(),
        )
      ) {
        failedByGroup.set(group.id, "EXPIRED");
        continue;
      }
      if (
        groupBatches.some(
          (batch) =>
            batch.status !== "PREVIEW" ||
            batch.unknownSkuRows > 0 ||
            batch.invalidRows > 0,
        ) ||
        groupRows.some(
          (row) => row.status === "UNKNOWN_SKU" || row.status === "INVALID",
        )
      ) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      if (groupRows.some((row) => row.status === "READY" && !isReadyRow(row))) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      const candidates = candidateRows(groupRows);
      if (candidates.length === 0 || candidates.some((row) => !isReadyRow(row))) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      const recipientByOrder = new Map<string, string>();
      let mismatchedRecipient = false;
      for (const row of candidates as ReadyRow[]) {
        const existingRecipient = recipientByOrder.get(row.externalOrderNo);
        if (
          existingRecipient !== undefined &&
          existingRecipient !== row.recipientPayloadEncrypted
        ) {
          mismatchedRecipient = true;
          break;
        }
        recipientByOrder.set(
          row.externalOrderNo,
          row.recipientPayloadEncrypted,
        );
      }
      if (mismatchedRecipient) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      candidateByGroup.set(group.id, {
        batches: groupBatches,
        rows: candidates as ReadyRow[],
      });
    }

    const candidateSubOrders = [
      ...new Set(
        [...candidateByGroup.values()].flatMap((work) =>
          work.rows.map((row) => row.externalSubOrderNo),
        ),
      ),
    ];
    await lockSubmissionConflicts(tx, {
      customerId: input.customerId,
      fileHashes: [...candidateByGroup.values()].flatMap((work) =>
        work.batches.map((batch) => batch.fileSha256),
      ),
      subOrderNos: candidateSubOrders,
    });
    if (candidateSubOrders.length > 0) {
      const existingLines = await tx
        .select({
          externalSubOrderNo: orderLines.externalSubOrderNo,
          storeId: orderLines.storeId,
        })
        .from(orderLines)
        .innerJoin(
          fulfillmentOrders,
          eq(fulfillmentOrders.id, orderLines.orderId),
        )
        .where(
          and(
            eq(fulfillmentOrders.customerId, input.customerId),
            inArray(orderLines.externalSubOrderNo, candidateSubOrders),
          ),
        );
      for (const group of selectedGroups) {
        const work = candidateByGroup.get(group.id);
        if (!work) continue;
        const subOrders = new Set(
          work.rows.map((row) => row.externalSubOrderNo),
        );
        const conflicts = existingLines.filter(
          (line) =>
            line.externalSubOrderNo && subOrders.has(line.externalSubOrderNo),
        );
        if (conflicts.some((line) => line.storeId !== group.storeId)) {
          failedByGroup.set(group.id, "CROSS_STORE_CONFLICT");
          candidateByGroup.delete(group.id);
        } else if (conflicts.length > 0) {
          failedByGroup.set(group.id, "DUPLICATE_CHANGED");
          candidateByGroup.delete(group.id);
        }
      }
    }

    const selectedHashes = [
      ...new Set(
        [...candidateByGroup.values()].flatMap((work) =>
          work.batches.map((batch) => batch.fileSha256),
        ),
      ),
    ];
    if (selectedHashes.length > 0) {
      const matchingBatches = await tx
        .select({
          fileSha256: orderImportBatches.fileSha256,
          storeId: orderImportBatches.storeId,
        })
        .from(orderImportBatches)
        .where(
          and(
            eq(orderImportBatches.customerId, input.customerId),
            inArray(orderImportBatches.fileSha256, selectedHashes),
          ),
        );
      for (const group of selectedGroups) {
        const work = candidateByGroup.get(group.id);
        if (!work) continue;
        const hashes = new Set(work.batches.map((batch) => batch.fileSha256));
        if (
          matchingBatches.some(
            (batch) =>
              hashes.has(batch.fileSha256) && batch.storeId !== group.storeId,
          )
        ) {
          failedByGroup.set(group.id, "CROSS_STORE_CONFLICT");
          candidateByGroup.delete(group.id);
        }
      }
    }

    const skuIds = [
      ...new Set(
        [...candidateByGroup.values()].flatMap((work) =>
          work.rows.map((row) => row.resolvedSkuId),
        ),
      ),
    ].sort();
    const skuRows =
      skuIds.length === 0
        ? []
        : await tx
            .select({
              id: skus.id,
              name: skus.name,
              saleStatus: skus.saleStatus,
              skuCode: skus.skuCode,
            })
            .from(skus)
            .where(inArray(skus.id, skuIds));
    const skuById = new Map(skuRows.map((sku) => [sku.id, sku]));
    const priceBySku = new Map<string, number>();
    for (const skuId of skuIds) {
      const sku = skuById.get(skuId);
      if (!sku || sku.saleStatus !== "SELLABLE") continue;
      try {
        const price = await resolveUnitPrice(tx, {
          customerId: input.customerId,
          skuId,
        });
        if (Number.isSafeInteger(price) && price >= 0) {
          priceBySku.set(skuId, price);
        }
      } catch {
        // The affected group is classified INVALID below without leaking detail.
      }
    }

    const preparedGroups: PreparedGroup[] = [];
    for (const group of selectedGroups) {
      const work = candidateByGroup.get(group.id);
      if (!work) continue;
      if (
        work.rows.some(
          (row) =>
            !skuById.has(row.resolvedSkuId) ||
            skuById.get(row.resolvedSkuId)!.saleStatus !== "SELLABLE" ||
            !priceBySku.has(row.resolvedSkuId),
        )
      ) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      const quantityBySku = new Map<string, number>();
      let totalAmountFen = 0;
      let totalQuantity = 0;
      for (const row of work.rows) {
        const quantity = safeAdd(
          quantityBySku.get(row.resolvedSkuId) ?? 0,
          row.quantity,
        );
        quantityBySku.set(row.resolvedSkuId, quantity);
        totalQuantity = safeAdd(totalQuantity, row.quantity);
        totalAmountFen = safeAdd(
          totalAmountFen,
          safeMultiply(row.quantity, priceBySku.get(row.resolvedSkuId)!),
        );
      }
      if (totalAmountFen <= 0) {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      preparedGroups.push({
        batches: work.batches,
        group,
        orderId: crypto.randomUUID(),
        orderNumber: createFulfillmentOrderNumber(now),
        quantityBySku,
        rows: work.rows,
        totalAmountFen,
        totalPackageCount: new Set(
          work.rows.map((row) => row.externalOrderNo),
        ).size,
        totalQuantity,
      });
    }

    const lockExpiresAt = new Date(now.getTime() + UNPAID_ORDER_LOCK_MS);
    const inventory = await reserveInventoryForGroups(
      tx,
      preparedGroups.map((prepared) => ({
        expiresAt: lockExpiresAt,
        groupId: prepared.group.id,
        quantityBySku: prepared.quantityBySku,
        referenceId: prepared.orderId,
        referenceType: "FULFILLMENT_ORDER",
      })),
    );
    for (const groupId of inventory.blockedGroupIds) {
      failedByGroup.set(groupId, "STOCK_CHANGED");
    }
    const successfulGroups = preparedGroups.filter(
      (prepared) => !inventory.blockedGroupIds.has(prepared.group.id),
    );
    const createdOrders: BulkCreatedOrder[] = [];
    for (const prepared of successfulGroups) {
      await tx.insert(fulfillmentOrders).values({
        customerId: input.customerId,
        id: prepared.orderId,
        lockExpiresAt,
        orderNumber: prepared.orderNumber,
        source: "TEMU_EXCEL",
        status: "PENDING_PAYMENT",
        storeId: prepared.group.storeId,
        totalAmountFen: prepared.totalAmountFen,
        totalPackageCount: prepared.totalPackageCount,
        totalQuantity: prepared.totalQuantity,
      });
      await tx.insert(fulfillmentOrderImportBatches).values(
        prepared.batches.map((batch) => ({
          importBatchId: batch.id,
          orderId: prepared.orderId,
        })),
      );
      const shipmentRows = new Map<
        string,
        { externalOrderNo: string; recipientPayloadEncrypted: string }
      >();
      for (const row of prepared.rows) {
        shipmentRows.set(row.externalOrderNo, {
          externalOrderNo: row.externalOrderNo,
          recipientPayloadEncrypted: row.recipientPayloadEncrypted,
        });
      }
      const insertedShipments = await tx
        .insert(orderShipments)
        .values(
          [...shipmentRows.values()].map((shipment) => ({
            ...shipment,
            orderId: prepared.orderId,
            storeId: prepared.group.storeId,
          })),
        )
        .returning({
          externalOrderNo: orderShipments.externalOrderNo,
          id: orderShipments.id,
        });
      const shipmentIdByOrder = new Map(
        insertedShipments.map((shipment) => [
          shipment.externalOrderNo,
          shipment.id,
        ]),
      );
      await tx.insert(orderLines).values(
        prepared.rows.map((row) => {
          const sku = skuById.get(row.resolvedSkuId)!;
          const unitPriceFen = priceBySku.get(row.resolvedSkuId)!;
          return {
            externalSku: row.externalSku,
            externalSubOrderNo: row.externalSubOrderNo,
            lineAmountFen: safeMultiply(row.quantity, unitPriceFen),
            orderId: prepared.orderId,
            quantity: row.quantity,
            shipmentId: shipmentIdByOrder.get(row.externalOrderNo)!,
            skuCodeSnapshot: sku.skuCode,
            skuId: sku.id,
            skuNameSnapshot: sku.name,
            storeId: prepared.group.storeId,
            unitPriceFen,
          };
        }),
      );
      const batchIdsForGroup = prepared.batches.map((batch) => batch.id);
      await tx
        .update(orderImportBatches)
        .set({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
        .where(inArray(orderImportBatches.id, batchIdsForGroup));
      await tx
        .update(bulkImportStoreGroups)
        .set({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
        .where(eq(bulkImportStoreGroups.id, prepared.group.id));
      await tx.insert(auditLogs).values({
        action: "FULFILLMENT_ORDER_SUBMITTED",
        actorId: input.actorUserId,
        actorType: "CUSTOMER",
        afterJson: {
          lockExpiresAt: lockExpiresAt.toISOString(),
          status: "PENDING_PAYMENT",
          totalAmountFen: prepared.totalAmountFen,
          totalPackageCount: prepared.totalPackageCount,
          totalQuantity: prepared.totalQuantity,
        },
        beforeJson: { bulkStoreGroupId: prepared.group.id },
        entityId: prepared.orderId,
        entityType: "FULFILLMENT_ORDER",
        reason: "客户批量确认 TEMU 导入并提交拿货单",
      });
      await enqueueCargoSyncEvent(tx, {
        idempotencyKey: `order-submitted:${prepared.orderId}`,
        now,
        reason: "order-inventory-reserved",
      });
      createdOrders.push({
        groupId: prepared.group.id,
        orderId: prepared.orderId,
        orderNumber: prepared.orderNumber,
        status: "ORDER_CREATED",
        storeId: prepared.group.storeId,
        totalAmountFen: prepared.totalAmountFen,
        totalPackageCount: prepared.totalPackageCount,
        totalQuantity: prepared.totalQuantity,
      });
    }

    const settlementBatchId = await createSubmissionSettlement(tx, {
      actorUserId: input.actorUserId,
      createdOrders,
      customerId: input.customerId,
      lockExpiresAt,
      now,
      requestedWalletFen: input.requestedWalletFen,
      scopeDigest,
    });
    await updateDraftAfterSubmission(tx, {
      createdOrderCount: createdOrders.length,
      draftExpired,
      draftId: draft.id,
      now,
    });

    const failedGroups = selectedGroups
      .filter((group) => failedByGroup.has(group.id))
      .map((group) => ({
        groupId: group.id,
        status: failedByGroup.get(group.id)!,
        storeId: group.storeId,
      }));
    const result = orderedResult({
      createdOrders,
      failedGroups,
      settlementBatchId,
    });
    await recordIdempotentResult(tx, {
      actorUserId: input.actorUserId,
      customerId: input.customerId,
      draftId: input.draftId,
      idempotencyKey,
      result,
      scopeDigest,
      settlementBatchId,
      selectedGroupCount: selectedGroupIds.length,
    });
    return result;
  });
}
