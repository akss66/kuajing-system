import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
  inventoryReservations,
  orderImportBatches,
  orderImportRowFulfillmentItems,
  orderImportRows,
  orderLines,
  orderShipments,
  skus,
} from "@/db/schema";
import { resolveUnitPrice } from "@/modules/catalog/pricing";
import { calculateLineAmountFen } from "@/modules/catalog/unit-price";
import { reserveInventory } from "@/modules/inventory/service";
import { enqueueCargoSyncEvent } from "@/modules/feishu/outbox";
import { tryDebitWalletForOrder } from "@/modules/wallet/service";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";
import { revalidateBatchInventory } from "@/modules/order-import/service";

import { lockActiveOrderUniqueKeys } from "./import-conflict-lock";
import { calculateOrderPricing, PACKAGE_SHIPPING_FEE_FEN } from "./pricing";

export const UNPAID_ORDER_LOCK_MS = 2 * 60 * 60 * 1_000;

type OrderSubmissionErrorCode =
  | "BATCH_NOT_FOUND"
  | "BATCH_EXPIRED"
  | "IMPORT_NOT_READY"
  | "NO_READY_ROWS"
  | "INVALID_IMPORT_ROW"
  | "SKU_NOT_SELLABLE"
  | "INSUFFICIENT_INVENTORY"
  | "AMOUNT_OVERFLOW";

export class OrderSubmissionError extends Error {
  constructor(
    public readonly code: OrderSubmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrderSubmissionError";
  }
}

export type SubmittedOrderView = {
  orderId: string;
  orderNumber: string;
  status:
    | "PENDING_PAYMENT"
    | "PAID_PENDING_FULFILLMENT"
    | "FULFILLING"
    | "SHIPPED"
    | "FULFILLMENT_EXCEPTION"
    | "CANCELLED"
    | "EXPIRED";
  totalAmountFen: number;
  totalPackageCount: number;
  totalQuantity: number;
  lockExpiresAt: Date | null;
};

type SubmissionOutcome =
  | { kind: "ORDER"; order: SubmittedOrderView }
  | { kind: "ERROR"; code: OrderSubmissionErrorCode; message: string };

export function createFulfillmentOrderNumber(now: Date) {
  const date = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
  })
    .format(now)
    .replaceAll("-", "");
  return `TH-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function toView(order: {
  id: string;
  orderNumber: string;
  status: SubmittedOrderView["status"];
  totalAmountFen: number;
  totalPackageCount: number;
  totalQuantity: number;
  lockExpiresAt: Date | null;
}): SubmittedOrderView {
  return {
    lockExpiresAt: order.lockExpiresAt,
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalAmountFen: order.totalAmountFen,
    totalPackageCount: order.totalPackageCount,
    totalQuantity: order.totalQuantity,
  };
}

function safeAdd(first: number, second: number) {
  const result = first + second;
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) {
    throw new OrderSubmissionError("AMOUNT_OVERFLOW", "订单金额或数量超出系统范围");
  }
  return result;
}

export async function submitTemuImportBatch(input: {
  actorUserId: string;
  batchId: string;
  customerId: string;
}): Promise<SubmittedOrderView> {
  const outcome: SubmissionOutcome = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select({
        customerId: orderImportBatches.customerId,
        duplicateRows: orderImportBatches.duplicateRows,
        expiresAt: orderImportBatches.expiresAt,
        id: orderImportBatches.id,
        invalidRows: orderImportBatches.invalidRows,
        readyRows: orderImportBatches.readyRows,
        status: orderImportBatches.status,
        storeId: orderImportBatches.storeId,
        unknownSkuRows: orderImportBatches.unknownSkuRows,
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
      throw new OrderSubmissionError("BATCH_NOT_FOUND", "找不到该导入预览");
    }

    if (batch.status === "SUBMITTED") {
      const [existing] = await tx
        .select({
          id: fulfillmentOrders.id,
          lockExpiresAt: fulfillmentOrders.lockExpiresAt,
          orderNumber: fulfillmentOrders.orderNumber,
          status: fulfillmentOrders.status,
          totalAmountFen: fulfillmentOrders.totalAmountFen,
          totalPackageCount: fulfillmentOrders.totalPackageCount,
          totalQuantity: fulfillmentOrders.totalQuantity,
        })
        .from(fulfillmentOrders)
        .where(eq(fulfillmentOrders.importBatchId, batch.id))
        .limit(1);
      if (!existing) {
        throw new OrderSubmissionError(
          "INVALID_IMPORT_ROW",
          "导入批次状态异常，请联系管理员",
        );
      }
      return { kind: "ORDER", order: toView(existing) };
    }

    const now = new Date();
    if (batch.status === "EXPIRED" || batch.expiresAt <= now) {
      await tx
        .update(orderImportBatches)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(orderImportBatches.id, batch.id));
      return {
        code: "BATCH_EXPIRED",
        kind: "ERROR",
        message: "导入预览已过期，请重新上传",
      };
    }
    if (batch.status !== "PREVIEW") {
      throw new OrderSubmissionError("IMPORT_NOT_READY", "导入预览当前不能提交");
    }
    const inventoryValidation = await revalidateBatchInventory(tx, batch.id, now);
    if (inventoryValidation.insufficientSkuIds.size > 0) {
      return {
        code: "INSUFFICIENT_INVENTORY",
        kind: "ERROR",
        message: "订单库存不足，预览已更新，请更换 SKU 或减少数量",
      };
    }
    if (
      inventoryValidation.summary.unknownSku > 0 ||
      inventoryValidation.summary.invalid > 0
    ) {
      throw new OrderSubmissionError(
        "IMPORT_NOT_READY",
        "请先处理未映射 SKU 和格式错误",
      );
    }

    let readyRows = await tx
      .select({
        externalOrderNo: orderImportRows.externalOrderNo,
        externalSku: orderImportRows.externalSku,
        externalSubOrderNo: orderImportRows.externalSubOrderNo,
        effectiveQuantity: orderImportRows.effectiveQuantity,
        finalSkuCode: orderImportRows.finalSkuCode,
        fulfillmentMode: orderImportRows.fulfillmentMode,
        id: orderImportRows.id,
        productName: orderImportRows.productName,
        quantity: orderImportRows.quantity,
        recipientPayloadEncrypted: orderImportRows.recipientPayloadEncrypted,
        resolvedSkuId: orderImportRows.resolvedSkuId,
        rowNumber: orderImportRows.rowNumber,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, batch.id),
          eq(orderImportRows.status, "READY"),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber));

    const subOrderNumbers = readyRows.flatMap((row) =>
      row.externalSubOrderNo ? [row.externalSubOrderNo] : [],
    );
    if (subOrderNumbers.length) {
      const externalOrderNumbers = readyRows.flatMap((row) =>
        row.externalOrderNo ? [row.externalOrderNo] : [],
      );
      await lockActiveOrderUniqueKeys(tx, [
        {
          externalOrderNumbers,
          externalSubOrderNumbers: subOrderNumbers,
          storeId: batch.storeId,
        },
      ]);
      const [existingRows, existingShipments] = await Promise.all([
        tx
          .select({ externalSubOrderNo: orderLines.externalSubOrderNo })
          .from(orderLines)
          .where(
            and(
              eq(orderLines.storeId, batch.storeId),
              eq(orderLines.deduplicationActive, true),
              inArray(orderLines.externalSubOrderNo, subOrderNumbers),
            ),
          ),
        tx
          .select({ externalOrderNo: orderShipments.externalOrderNo })
          .from(orderShipments)
          .where(
            and(
              eq(orderShipments.storeId, batch.storeId),
              eq(orderShipments.deduplicationActive, true),
              inArray(orderShipments.externalOrderNo, externalOrderNumbers),
            ),
          ),
      ]);
      const existingExternalOrders = new Set(
        existingShipments.map((row) => row.externalOrderNo),
      );
      const newlyDuplicate = new Set(
        [
          ...existingRows.flatMap((row) =>
            row.externalSubOrderNo ? [row.externalSubOrderNo] : [],
          ),
          ...readyRows.flatMap((row) =>
            row.externalOrderNo &&
            row.externalSubOrderNo &&
            existingExternalOrders.has(row.externalOrderNo)
              ? [row.externalSubOrderNo]
              : [],
          ),
        ],
      );
      if (newlyDuplicate.size) {
        await tx
          .update(orderImportRows)
          .set({ status: "DUPLICATE" })
          .where(
            and(
              eq(orderImportRows.batchId, batch.id),
              inArray(orderImportRows.externalSubOrderNo, [...newlyDuplicate]),
            ),
          );
        await tx
          .update(orderImportBatches)
          .set({
            duplicateRows:
              inventoryValidation.summary.duplicate + newlyDuplicate.size,
            readyRows: inventoryValidation.summary.ready - newlyDuplicate.size,
            updatedAt: now,
          })
          .where(eq(orderImportBatches.id, batch.id));
        readyRows = readyRows.filter(
          (row) =>
            !row.externalSubOrderNo ||
            !newlyDuplicate.has(row.externalSubOrderNo),
        );
      }
    }

    if (readyRows.length === 0) {
      return {
        code: "NO_READY_ROWS",
        kind: "ERROR",
        message: "没有可提交的新订单",
      };
    }
    for (const row of readyRows) {
      if (
        !row.externalOrderNo ||
        !row.externalSubOrderNo ||
        !row.externalSku ||
        !row.recipientPayloadEncrypted ||
        !row.quantity ||
        row.quantity <= 0 ||
        !row.effectiveQuantity ||
        row.effectiveQuantity <= 0 ||
        (row.fulfillmentMode === "CUSTOMER_SUPPLIED" && !row.finalSkuCode) ||
        (row.fulfillmentMode === "SYSTEM_SKU" && !row.resolvedSkuId) ||
        (row.fulfillmentMode === "CUSTOMER_SUPPLIED" && row.resolvedSkuId)
      ) {
        throw new OrderSubmissionError(
          "INVALID_IMPORT_ROW",
          `第 ${row.rowNumber} 行缺少提交所需字段`,
        );
      }
    }

    const additionalItems = await tx
      .select({
        effectiveQuantity: orderImportRowFulfillmentItems.effectiveQuantity,
        finalSkuCode: orderImportRowFulfillmentItems.finalSkuCode,
        fulfillmentMode: orderImportRowFulfillmentItems.fulfillmentMode,
        position: orderImportRowFulfillmentItems.position,
        resolvedSkuId: orderImportRowFulfillmentItems.resolvedSkuId,
        rowId: orderImportRowFulfillmentItems.rowId,
      })
      .from(orderImportRowFulfillmentItems)
      .where(
        inArray(
          orderImportRowFulfillmentItems.rowId,
          readyRows.map((row) => row.id),
        ),
      )
      .orderBy(
        asc(orderImportRowFulfillmentItems.rowId),
        asc(orderImportRowFulfillmentItems.position),
      )
      .for("share");
    const additionalItemsByRowId = new Map<string, typeof additionalItems>();
    for (const item of additionalItems) {
      const items = additionalItemsByRowId.get(item.rowId) ?? [];
      items.push(item);
      additionalItemsByRowId.set(item.rowId, items);
    }
    const readyItems = readyRows.flatMap((row) => [
      {
        effectiveQuantity: row.effectiveQuantity!,
        finalSkuCode: row.finalSkuCode,
        fulfillmentMode: row.fulfillmentMode,
        position: 1,
        resolvedSkuId: row.resolvedSkuId,
        row,
      },
      ...(additionalItemsByRowId.get(row.id) ?? []).map((item) => ({
        effectiveQuantity: item.effectiveQuantity,
        finalSkuCode: item.finalSkuCode,
        fulfillmentMode: item.fulfillmentMode,
        position: item.position,
        resolvedSkuId: item.resolvedSkuId,
        row,
      })),
    ]);
    const systemRows = readyItems.filter(
      (item) => item.fulfillmentMode === "SYSTEM_SKU",
    );
    const skuIds = [
      ...new Set(systemRows.map((item) => item.resolvedSkuId!)),
    ].sort();
    const skuRows = await tx
      .select({
        archivedAt: skus.archivedAt,
        id: skus.id,
        lifecycleStatus: skus.lifecycleStatus,
        name: skus.name,
        saleStatus: skus.saleStatus,
        skuCode: skus.skuCode,
      })
      .from(skus)
      .where(inArray(skus.id, skuIds))
      .for("share");
    const skuById = new Map(skuRows.map((sku) => [sku.id, sku]));
    const unavailableSkuIds = skuIds.filter((skuId) => {
      const sku = skuById.get(skuId);
      return (
        !sku ||
        sku.lifecycleStatus !== "ACTIVE" ||
        sku.saleStatus !== "SELLABLE" ||
        sku.archivedAt !== null
      );
    });
    if (unavailableSkuIds.length > 0) {
      const affectedRowIds = [
        ...new Set(
          readyItems
            .filter(
              (item) =>
                item.resolvedSkuId &&
                unavailableSkuIds.includes(item.resolvedSkuId),
            )
            .map((item) => item.row.id),
        ),
      ];
      const reclassifiedRows = await tx
        .update(orderImportRows)
        .set({
          errorCode: "SKU_UNAVAILABLE",
          errorMessage: "SKU 已下架或不可售，请联系管理员处理",
          status: "UNKNOWN_SKU",
        })
        .where(
          and(
            eq(orderImportRows.batchId, batch.id),
            eq(orderImportRows.status, "READY"),
            inArray(orderImportRows.id, affectedRowIds),
          ),
        )
        .returning({ rowNumber: orderImportRows.rowNumber });
      await tx
        .update(orderImportRows)
        .set({ resolvedSkuId: null })
        .where(
          and(
            eq(orderImportRows.batchId, batch.id),
            inArray(orderImportRows.resolvedSkuId, unavailableSkuIds),
          ),
        );
      if (reclassifiedRows.length > 0) {
        await tx
          .update(orderImportBatches)
          .set({
            readyRows: sql`${orderImportBatches.readyRows} - ${reclassifiedRows.length}`,
            unknownSkuRows: sql`${orderImportBatches.unknownSkuRows} + ${reclassifiedRows.length}`,
            updatedAt: now,
          })
          .where(eq(orderImportBatches.id, batch.id));
        await tx.insert(auditLogs).values({
          action: "TEMU_IMPORT_PREVIEW_RECLASSIFIED",
          actorId: input.actorUserId,
          actorType: "CUSTOMER",
          afterJson: {
            affectedRows: reclassifiedRows.length,
            reason: "SKU_UNAVAILABLE",
          },
          beforeJson: { status: "READY" },
          entityId: batch.id,
          entityType: "ORDER_IMPORT_BATCH",
          reason: "提交时发现 SKU 已下架或不可售，阻止创建拿货单",
        });
      }
      return {
        code: "SKU_NOT_SELLABLE",
        kind: "ERROR",
        message: "订单中有 SKU 已下架或不可售，预览已更新，请联系管理员处理",
      };
    }
    const priceBySkuId = new Map<
      string,
      Awaited<ReturnType<typeof resolveUnitPrice>>
    >();
    for (const skuId of skuIds) {
      priceBySkuId.set(
        skuId,
        await resolveUnitPrice(tx, {
          skuId,
        }),
      );
    }

    const quantityBySkuId = new Map<string, number>();
    let merchandiseAmountFen = 0;
    let totalQuantity = 0;
    for (const item of readyItems) {
      const quantity = item.effectiveQuantity;
      totalQuantity = safeAdd(totalQuantity, quantity);
      if (item.fulfillmentMode === "CUSTOMER_SUPPLIED") continue;
      const skuId = item.resolvedSkuId!;
      const price = priceBySkuId.get(skuId)!;
      quantityBySkuId.set(
        skuId,
        safeAdd(quantityBySkuId.get(skuId) ?? 0, quantity),
      );
      merchandiseAmountFen = safeAdd(
        merchandiseAmountFen,
        calculateLineAmountFen(quantity, price.unitPriceMilliYuan),
      );
    }

    const shipmentRows = new Map<
      string,
      { externalOrderNo: string; recipientPayloadEncrypted: string }
    >();
    for (const row of readyRows) {
      shipmentRows.set(row.externalOrderNo!, {
        externalOrderNo: row.externalOrderNo!,
        recipientPayloadEncrypted: row.recipientPayloadEncrypted!,
      });
    }

    let pricing: ReturnType<typeof calculateOrderPricing>;
    try {
      pricing = calculateOrderPricing({
        merchandiseAmountFen,
        packageCount: shipmentRows.size,
      });
    } catch {
      throw new OrderSubmissionError(
        "AMOUNT_OVERFLOW",
        "订单金额或包裹数量超出系统范围",
      );
    }
    const { shippingFeeFen, totalAmountFen } = pricing;

    const orderId = crypto.randomUUID();
    const lockExpiresAt = new Date(now.getTime() + UNPAID_ORDER_LOCK_MS);
    const number = createFulfillmentOrderNumber(now);
    await tx.insert(fulfillmentOrders).values({
      customerId: batch.customerId,
      id: orderId,
      importBatchId: batch.id,
      lockExpiresAt,
      orderNumber: number,
      source: "TEMU_EXCEL",
      status: "PENDING_PAYMENT",
      storeId: batch.storeId,
      totalAmountFen,
      totalPackageCount: shipmentRows.size,
      totalQuantity,
    });

    for (const skuId of skuIds) {
      await reserveInventory(tx, {
        expiresAt: lockExpiresAt,
        quantity: quantityBySkuId.get(skuId)!,
        referenceId: orderId,
        referenceType: "FULFILLMENT_ORDER",
        skuId,
      });
    }

    const paidFromWallet = await tryDebitWalletForOrder(tx, {
      actorUserId: input.actorUserId,
      amountFen: totalAmountFen,
      customerId: batch.customerId,
      orderId,
    });
    let finalStatus: SubmittedOrderView["status"] = "PENDING_PAYMENT";
    let finalLockExpiresAt: Date | null = lockExpiresAt;
    if (paidFromWallet) {
      finalStatus = "PAID_PENDING_FULFILLMENT";
      finalLockExpiresAt = null;
      await tx
        .update(fulfillmentOrders)
        .set({
          lockExpiresAt: null,
          paidAt: now,
          paymentMode: "WALLET",
          status: "PAID_PENDING_FULFILLMENT",
          updatedAt: now,
        })
        .where(eq(fulfillmentOrders.id, orderId));
      await tx
        .update(inventoryReservations)
        .set({ expiresAt: null, updatedAt: now })
        .where(
          and(
            eq(inventoryReservations.referenceType, "FULFILLMENT_ORDER"),
            eq(inventoryReservations.referenceId, orderId),
            eq(inventoryReservations.status, "ACTIVE"),
          ),
        );
    }

    const insertedShipments = await tx
      .insert(orderShipments)
      .values(
        [...shipmentRows.values()].map((shipment) => ({
          ...shipment,
          orderId,
          shippingFeeFen: PACKAGE_SHIPPING_FEE_FEN,
          storeId: batch.storeId,
        })),
      )
      .returning({
        externalOrderNo: orderShipments.externalOrderNo,
        id: orderShipments.id,
      });
    const shipmentIdByExternalOrder = new Map(
      insertedShipments.map((shipment) => [shipment.externalOrderNo, shipment.id]),
    );

    await tx.insert(orderLines).values(
      readyItems.map((item) => {
        const row = item.row;
        if (item.fulfillmentMode === "CUSTOMER_SUPPLIED") {
          return {
            externalSku: row.externalSku!,
            externalSubOrderNo: row.externalSubOrderNo!,
            lineAmountFen: 0,
            lineKind: "CUSTOMER_SUPPLIED" as const,
            linePosition: item.position,
            orderId,
            quantity: item.effectiveQuantity,
            shipmentId: shipmentIdByExternalOrder.get(row.externalOrderNo!)!,
            skuCodeSnapshot: item.finalSkuCode!,
            skuId: null,
            skuNameSnapshot: row.productName || "客户自有货",
            storeId: batch.storeId,
            unitPriceFen: 0,
            unitPriceMilliYuan: 0,
          };
        }
        const sku = skuById.get(item.resolvedSkuId!)!;
        const price = priceBySkuId.get(sku.id)!;
        return {
          externalSku: row.externalSku!,
          externalSubOrderNo: row.externalSubOrderNo!,
          lineAmountFen: calculateLineAmountFen(
            item.effectiveQuantity,
            price.unitPriceMilliYuan,
          ),
          linePosition: item.position,
          orderId,
          lineKind: "SYSTEM_SKU" as const,
          quantity: item.effectiveQuantity,
          shipmentId: shipmentIdByExternalOrder.get(row.externalOrderNo!)!,
          skuCodeSnapshot: sku.skuCode,
          skuId: sku.id,
          skuNameSnapshot: sku.name,
          storeId: batch.storeId,
          unitPriceFen: price.unitPriceFen,
          unitPriceMilliYuan: price.unitPriceMilliYuan,
        };
      }),
    );

    await tx
      .update(orderImportBatches)
      .set({ status: "SUBMITTED", submittedAt: now, updatedAt: now })
      .where(eq(orderImportBatches.id, batch.id));
    await tx.insert(auditLogs).values({
      action: "FULFILLMENT_ORDER_SUBMITTED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        lockExpiresAt: finalLockExpiresAt?.toISOString() ?? null,
        merchandiseAmountFen,
        paymentMode: paidFromWallet ? "WALLET" : null,
        shippingFeeFen,
        status: finalStatus,
        totalAmountFen,
        totalPackageCount: shipmentRows.size,
        totalQuantity,
      },
      beforeJson: { importBatchId: batch.id },
      entityId: orderId,
      entityType: "FULFILLMENT_ORDER",
      reason: "客户确认 TEMU 导入并提交拿货单",
    });
    await enqueueCargoSyncEvent(tx, {
      idempotencyKey: `order-submitted:${orderId}`,
      now,
      reason: "order-inventory-reserved",
    });

    return {
      kind: "ORDER",
      order: {
        lockExpiresAt: finalLockExpiresAt,
        orderId,
        orderNumber: number,
        status: finalStatus,
        totalAmountFen,
        totalPackageCount: shipmentRows.size,
        totalQuantity,
      },
    };
  });

  if (outcome.kind === "ERROR") {
    throw new OrderSubmissionError(outcome.code, outcome.message);
  }
  return outcome.order;
}
