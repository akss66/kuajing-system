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
  orderImportRowFulfillmentItems,
  orderImportRows,
  orderLines,
  orderShipments,
  settlementBatchOrders,
  settlementBatches,
  skus,
  stores,
} from "@/db/schema";
import { resolveUnitPrice } from "@/modules/catalog/pricing";
import { calculateLineAmountFen } from "@/modules/catalog/unit-price";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { reserveInventoryForGroups } from "@/modules/inventory/service";
import {
  createFulfillmentOrderNumber,
  UNPAID_ORDER_LOCK_MS,
} from "@/modules/orders/submission";
import { lockActiveOrderUniqueKeys } from "@/modules/orders/import-conflict-lock";
import { calculateOrderPricing } from "@/modules/orders/pricing";
import {
  applyBulkSettlementWallet,
  lockWalletFunding,
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
  effectiveQuantity: number | null;
  externalOrderNo: string | null;
  externalSku: string | null;
  externalSubOrderNo: string | null;
  finalSkuCode: string | null;
  id: string;
  fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
  productName: string | null;
  quantity: number | null;
  linePosition: number;
  recipientPayloadEncrypted: string | null;
  resolvedSkuId: string | null;
  rowNumber: number;
  sourceRowId: string;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
};

type ReadyRow = LoadedRow & {
  effectiveQuantity: number;
  externalOrderNo: string;
  externalSku: string;
  externalSubOrderNo: string;
  quantity: number;
  recipientPayloadEncrypted: string;
};

type PreparedGroup = {
  batches: LoadedBatch[];
  group: StoreGroup;
  merchandiseAmountFen: number;
  orderId: string;
  orderNumber: string;
  packageShippingFeeFen: number;
  quantityBySku: Map<string, number>;
  rows: ReadyRow[];
  shippingFeeFen: number;
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
        first.linePosition - second.linePosition ||
        first.id.localeCompare(second.id),
    );
  return { groupBatches, groupRows };
}

function candidateRows(rows: readonly LoadedRow[]) {
  const firstSourceRowBySubOrder = new Map<string, string>();
  for (const row of rows) {
    if (
      !row.externalSubOrderNo ||
      firstSourceRowBySubOrder.has(row.externalSubOrderNo)
    ) {
      continue;
    }
    firstSourceRowBySubOrder.set(row.externalSubOrderNo, row.sourceRowId);
  }
  return rows.filter(
    (row) =>
      row.status !== "DUPLICATE" &&
      row.externalSubOrderNo &&
      firstSourceRowBySubOrder.get(row.externalSubOrderNo) === row.sourceRowId,
  );
}

function isReadyRow(row: LoadedRow): row is ReadyRow {
  return (
    row.status === "READY" &&
    Boolean(row.externalOrderNo) &&
    Boolean(row.externalSku) &&
    Boolean(row.externalSubOrderNo) &&
    Boolean(row.recipientPayloadEncrypted) &&
    Number.isSafeInteger(row.effectiveQuantity) &&
    (row.effectiveQuantity ?? 0) > 0 &&
    ((row.fulfillmentMode === "SYSTEM_SKU" && Boolean(row.resolvedSkuId)) ||
      (row.fulfillmentMode === "CUSTOMER_SUPPLIED" &&
        !row.resolvedSkuId &&
        Boolean(row.finalSkuCode)))
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
  const wallet =
    input.requestedWalletFen === 0
      ? null
      : await lockWalletFunding(tx, input.customerId);
  const actualWalletFen = Math.min(
    input.requestedWalletFen,
    totalAmountFen,
    wallet?.availableFen ?? 0,
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
  if (wallet) {
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
  }
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
    const baseRows =
      batchIds.length === 0
        ? []
        : await tx
            .select({
              batchId: orderImportRows.batchId,
              effectiveQuantity: orderImportRows.effectiveQuantity,
              externalOrderNo: orderImportRows.externalOrderNo,
              externalSku: orderImportRows.externalSku,
              externalSubOrderNo: orderImportRows.externalSubOrderNo,
              finalSkuCode: orderImportRows.finalSkuCode,
              id: orderImportRows.id,
              fulfillmentMode: orderImportRows.fulfillmentMode,
              productName: orderImportRows.productName,
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
    const additionalItems =
      baseRows.length === 0
        ? []
        : await tx
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
            .where(
              inArray(
                orderImportRowFulfillmentItems.rowId,
                baseRows.map((row) => row.id),
              ),
            )
            .orderBy(
              asc(orderImportRowFulfillmentItems.rowId),
              asc(orderImportRowFulfillmentItems.position),
            );
    const baseRowById = new Map(baseRows.map((row) => [row.id, row]));
    const loadedRows: LoadedRow[] = [
      ...baseRows.map((row) => ({
        ...row,
        linePosition: 1,
        sourceRowId: row.id,
      })),
      ...additionalItems.flatMap((item) => {
        const row = baseRowById.get(item.rowId);
        if (!row) return [];
        return [
          {
            ...row,
            effectiveQuantity: item.effectiveQuantity,
            finalSkuCode: item.finalSkuCode,
            fulfillmentMode: item.fulfillmentMode,
            id: item.id,
            linePosition: item.position,
            resolvedSkuId: item.resolvedSkuId,
            sourceRowId: row.id,
          },
        ];
      }),
    ];

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
    await lockActiveOrderUniqueKeys(
      tx,
      selectedGroups.flatMap((group) => {
        const work = candidateByGroup.get(group.id);
        return work
          ? [
              {
                externalOrderNumbers: work.rows.map(
                  (row) => row.externalOrderNo,
                ),
                externalSubOrderNumbers: work.rows.map(
                  (row) => row.externalSubOrderNo,
                ),
                storeId: group.storeId,
              },
            ]
          : [];
      }),
    );
    if (candidateSubOrders.length > 0) {
      const candidateExternalOrders = [
        ...new Set(
          [...candidateByGroup.values()].flatMap((work) =>
            work.rows.map((row) => row.externalOrderNo),
          ),
        ),
      ];
      const [existingLines, existingShipments] = await Promise.all([
        tx
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
              eq(orderLines.deduplicationActive, true),
              inArray(orderLines.externalSubOrderNo, candidateSubOrders),
            ),
          ),
        tx
          .select({
            externalOrderNo: orderShipments.externalOrderNo,
            storeId: orderShipments.storeId,
          })
          .from(orderShipments)
          .innerJoin(
            fulfillmentOrders,
            eq(fulfillmentOrders.id, orderShipments.orderId),
          )
          .where(
            and(
              eq(fulfillmentOrders.customerId, input.customerId),
              eq(orderShipments.deduplicationActive, true),
              inArray(
                orderShipments.externalOrderNo,
                candidateExternalOrders,
              ),
            ),
          ),
      ]);
      for (const group of selectedGroups) {
        const work = candidateByGroup.get(group.id);
        if (!work) continue;
        const subOrders = new Set(
          work.rows.map((row) => row.externalSubOrderNo),
        );
        const externalOrders = new Set(
          work.rows.map((row) => row.externalOrderNo),
        );
        const lineConflicts = existingLines.filter(
          (line) =>
            line.externalSubOrderNo && subOrders.has(line.externalSubOrderNo),
        );
        const shipmentConflicts = existingShipments.filter((shipment) =>
          externalOrders.has(shipment.externalOrderNo),
        );
        const conflicts = [...lineConflicts, ...shipmentConflicts];
        if (conflicts.some((row) => row.storeId !== group.storeId)) {
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
          work.rows.flatMap((row) =>
            row.fulfillmentMode === "SYSTEM_SKU" && row.resolvedSkuId
              ? [row.resolvedSkuId]
              : [],
          ),
        ),
      ),
    ].sort();
    const skuRows =
      skuIds.length === 0
        ? []
        : await tx
            .select({
              id: skus.id,
              lifecycleStatus: skus.lifecycleStatus,
              name: skus.name,
              saleStatus: skus.saleStatus,
              skuCode: skus.skuCode,
            })
            .from(skus)
            .where(inArray(skus.id, skuIds));
    const skuById = new Map(skuRows.map((sku) => [sku.id, sku]));
    const priceBySku = new Map<
      string,
      Awaited<ReturnType<typeof resolveUnitPrice>>
    >();
    for (const skuId of skuIds) {
      const sku = skuById.get(skuId);
      if (!sku || sku.lifecycleStatus !== "ACTIVE" || sku.saleStatus !== "SELLABLE") continue;
      try {
        const price = await resolveUnitPrice(tx, {
          skuId,
        });
        if (
          Number.isSafeInteger(price.unitPriceFen) &&
          price.unitPriceFen >= 0 &&
          Number.isSafeInteger(price.unitPriceMilliYuan) &&
          price.unitPriceMilliYuan >= 0
        ) {
          priceBySku.set(skuId, price);
        }
      } catch {
        // The affected group is classified INVALID below without leaking detail.
      }
    }

    const unavailableSkuIds = new Set(
      skuIds.filter((skuId) => {
        const sku = skuById.get(skuId);
        return (
          !sku ||
          sku.lifecycleStatus !== "ACTIVE" ||
          sku.saleStatus !== "SELLABLE" ||
          !priceBySku.has(skuId)
        );
      }),
    );

    const preparedGroups: PreparedGroup[] = [];
    for (const group of selectedGroups) {
      const work = candidateByGroup.get(group.id);
      if (!work) continue;
      const affectedRows = work.rows.filter(
        (row) =>
          row.fulfillmentMode === "SYSTEM_SKU" &&
          (!row.resolvedSkuId || unavailableSkuIds.has(row.resolvedSkuId)),
      );
      if (affectedRows.length > 0) {
        const sourceRows = [
          ...new Map(
            affectedRows.map((row) => [row.sourceRowId, row] as const),
          ).values(),
        ];
        const sourceRowIds = sourceRows.map((row) => row.sourceRowId);
        const reclassifiedRows = await tx
          .update(orderImportRows)
          .set({
            errorCode: "SKU_UNAVAILABLE",
            errorMessage: "SKU 已下架、不可售或缺少拿货价，请重新选择或联系管理员处理",
            status: "UNKNOWN_SKU",
          })
          .where(
            and(
              eq(orderImportRows.status, "READY"),
              inArray(orderImportRows.id, sourceRowIds),
            ),
          )
          .returning({
            batchId: orderImportRows.batchId,
            id: orderImportRows.id,
          });
        if (unavailableSkuIds.size > 0) {
          await tx
            .update(orderImportRows)
            .set({ resolvedSkuId: null })
            .where(
              and(
                inArray(orderImportRows.id, sourceRowIds),
                inArray(orderImportRows.resolvedSkuId, [...unavailableSkuIds]),
              ),
            );
        }
        const reclassifiedByBatch = new Map<string, number>();
        for (const row of reclassifiedRows) {
          reclassifiedByBatch.set(
            row.batchId,
            (reclassifiedByBatch.get(row.batchId) ?? 0) + 1,
          );
        }
        for (const [batchId, count] of reclassifiedByBatch) {
          await tx
            .update(orderImportBatches)
            .set({
              readyRows: sql`${orderImportBatches.readyRows} - ${count}`,
              unknownSkuRows: sql`${orderImportBatches.unknownSkuRows} + ${count}`,
              updatedAt: now,
            })
            .where(eq(orderImportBatches.id, batchId));
          await tx.insert(auditLogs).values({
            action: "TEMU_IMPORT_PREVIEW_RECLASSIFIED",
            actorId: input.actorUserId,
            actorType: "CUSTOMER",
            afterJson: {
              affectedRows: count,
              reason: "SKU_UNAVAILABLE",
            },
            beforeJson: { status: "READY" },
            entityId: batchId,
            entityType: "ORDER_IMPORT_BATCH",
            reason: "批量提交时发现 SKU 已下架、不可售或缺少拿货价，阻止创建拿货单",
          });
        }
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      const quantityBySku = new Map<string, number>();
      let merchandiseAmountFen = 0;
      let totalQuantity = 0;
      for (const row of work.rows) {
        totalQuantity = safeAdd(totalQuantity, row.effectiveQuantity);
        if (row.fulfillmentMode === "CUSTOMER_SUPPLIED") continue;
        const quantity = safeAdd(
          quantityBySku.get(row.resolvedSkuId!) ?? 0,
          row.effectiveQuantity,
        );
        quantityBySku.set(row.resolvedSkuId!, quantity);
        merchandiseAmountFen = safeAdd(
          merchandiseAmountFen,
          calculateLineAmountFen(
            row.effectiveQuantity,
            priceBySku.get(row.resolvedSkuId!)!.unitPriceMilliYuan,
          ),
        );
      }
      const totalPackageCount = new Set(
        work.rows.map((row) => row.externalOrderNo),
      ).size;
      let pricing: ReturnType<typeof calculateOrderPricing>;
      let packageShippingFeeFen: number;
      try {
        pricing = calculateOrderPricing({
          merchandiseAmountFen,
          packageCount: totalPackageCount,
        });
        packageShippingFeeFen = pricing.shippingFeeFen / totalPackageCount;
        if (!Number.isSafeInteger(packageShippingFeeFen)) {
          throw new RangeError("包裹运费无法精确分摊");
        }
      } catch {
        failedByGroup.set(group.id, "INVALID");
        continue;
      }
      preparedGroups.push({
        batches: work.batches,
        group,
        merchandiseAmountFen,
        orderId: crypto.randomUUID(),
        orderNumber: createFulfillmentOrderNumber(now),
        packageShippingFeeFen,
        quantityBySku,
        rows: work.rows,
        shippingFeeFen: pricing.shippingFeeFen,
        totalAmountFen: pricing.totalAmountFen,
        totalPackageCount,
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
            shippingFeeFen: prepared.packageShippingFeeFen,
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
          if (row.fulfillmentMode === "CUSTOMER_SUPPLIED") {
            return {
              externalSku: row.externalSku,
              externalSubOrderNo: row.externalSubOrderNo,
              lineAmountFen: 0,
              lineKind: "CUSTOMER_SUPPLIED" as const,
              linePosition: row.linePosition,
              orderId: prepared.orderId,
              quantity: row.effectiveQuantity,
              shipmentId: shipmentIdByOrder.get(row.externalOrderNo)!,
              skuCodeSnapshot: row.finalSkuCode!,
              skuId: null,
              skuNameSnapshot: row.productName || "客户自有货",
              storeId: prepared.group.storeId,
              unitPriceFen: 0,
              unitPriceMilliYuan: 0,
            };
          }
          const sku = skuById.get(row.resolvedSkuId!)!;
          const price = priceBySku.get(row.resolvedSkuId!)!;
          return {
            externalSku: row.externalSku,
            externalSubOrderNo: row.externalSubOrderNo,
            lineAmountFen: calculateLineAmountFen(
              row.effectiveQuantity,
              price.unitPriceMilliYuan,
            ),
            linePosition: row.linePosition,
            orderId: prepared.orderId,
            lineKind: "SYSTEM_SKU" as const,
            quantity: row.effectiveQuantity,
            shipmentId: shipmentIdByOrder.get(row.externalOrderNo)!,
            skuCodeSnapshot: sku.skuCode,
            skuId: sku.id,
            skuNameSnapshot: sku.name,
            storeId: prepared.group.storeId,
            unitPriceFen: price.unitPriceFen,
            unitPriceMilliYuan: price.unitPriceMilliYuan,
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
          merchandiseAmountFen: prepared.merchandiseAmountFen,
          shippingFeeFen: prepared.shippingFeeFen,
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
