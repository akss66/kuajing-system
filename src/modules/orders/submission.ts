import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  fulfillmentOrders,
  inventoryReservations,
  orderImportBatches,
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

import { lockActiveOrderUniqueKeys } from "./import-conflict-lock";
import { calculateOrderPricing } from "./pricing";

export const UNPAID_ORDER_LOCK_MS = 2 * 60 * 60 * 1_000;

type OrderSubmissionErrorCode =
  | "BATCH_NOT_FOUND"
  | "BATCH_EXPIRED"
  | "IMPORT_NOT_READY"
  | "NO_READY_ROWS"
  | "INVALID_IMPORT_ROW"
  | "SKU_NOT_SELLABLE"
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
    if (batch.unknownSkuRows > 0 || batch.invalidRows > 0) {
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
            duplicateRows: batch.duplicateRows + newlyDuplicate.size,
            readyRows: batch.readyRows - newlyDuplicate.size,
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
        !row.resolvedSkuId ||
        !row.recipientPayloadEncrypted ||
        !row.quantity ||
        row.quantity <= 0
      ) {
        throw new OrderSubmissionError(
          "INVALID_IMPORT_ROW",
          `第 ${row.rowNumber} 行缺少提交所需字段`,
        );
      }
    }

    const skuIds = [...new Set(readyRows.map((row) => row.resolvedSkuId!))].sort();
    const skuRows = await tx
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
    const priceBySkuId = new Map<
      string,
      Awaited<ReturnType<typeof resolveUnitPrice>>
    >();
    for (const skuId of skuIds) {
      const sku = skuById.get(skuId);
      if (!sku || sku.lifecycleStatus !== "ACTIVE" || sku.saleStatus !== "SELLABLE") {
        throw new OrderSubmissionError(
          "SKU_NOT_SELLABLE",
          "订单中有已下架 SKU，请重新预览",
        );
      }
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
    for (const row of readyRows) {
      const skuId = row.resolvedSkuId!;
      const quantity = row.quantity!;
      const price = priceBySkuId.get(skuId)!;
      quantityBySkuId.set(
        skuId,
        safeAdd(quantityBySkuId.get(skuId) ?? 0, quantity),
      );
      totalQuantity = safeAdd(totalQuantity, quantity);
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
      readyRows.map((row) => {
        const sku = skuById.get(row.resolvedSkuId!)!;
        const price = priceBySkuId.get(sku.id)!;
        return {
          externalSku: row.externalSku!,
          externalSubOrderNo: row.externalSubOrderNo!,
          lineAmountFen: calculateLineAmountFen(
            row.quantity!,
            price.unitPriceMilliYuan,
          ),
          orderId,
          quantity: row.quantity!,
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
