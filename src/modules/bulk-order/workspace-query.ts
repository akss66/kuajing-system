import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import {
  fulfillmentOrders,
  orderImportBatches,
  orderImportRows,
  orderLines,
  skus,
} from "@/db/schema";
import { calculateLineAmountFen } from "@/modules/catalog/unit-price";
import { calculateOrderPricing } from "@/modules/orders/pricing";

import { getBulkDraft } from "./draft-service";
import { validateBulkDraft } from "./validation-service";

type WorkspaceRow = {
  batchId: string;
  createdAt: Date;
  effectiveQuantity: number | null;
  externalOrderNo: string | null;
  externalSubOrderNo: string | null;
  fulfillmentMode: "SYSTEM_SKU" | "CUSTOMER_SUPPLIED";
  quantity: number | null;
  resolvedSkuId: string | null;
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "UNKNOWN_SKU" | "INVALID";
  storeGroupId: string | null;
};

const statusLabelMap = {
  ALREADY_SUBMITTED: "已提交",
  BLOCKED_CROSS_STORE: "跨店冲突",
  BLOCKED_INVALID: "格式问题",
  BLOCKED_INVENTORY: "库存变化",
  BLOCKED_UNKNOWN_SKU: "未映射 SKU",
  EMPTY: "无可提交订单",
  EXPIRED: "已过期",
  SUBMITTABLE: "可提交",
} as const;

const helperTextMap = {
  ALREADY_SUBMITTED: "该店铺已经生成拿货单，成功文件已锁定，不能重复提交。",
  BLOCKED_CROSS_STORE: "检测到跨店文件或跨店子订单，请移除冲突文件后重新上传。",
  BLOCKED_INVALID: "文件里仍有格式问题，请修正后重新上传；失败文件会保留。",
  BLOCKED_INVENTORY: "库存已变化，当前分组暂时不能提交；稍后可重新上传或减少数量。",
  BLOCKED_UNKNOWN_SKU: "存在未映射 SKU，请先联系管理员维护映射，再继续上传该店铺文件。",
  EMPTY: "去重后没有可提交订单，请继续上传该店铺文件。",
  EXPIRED: "草稿或文件已过期，请重新创建草稿并上传新的 TEMU 原始 Excel。",
  SUBMITTABLE: "继续上传 TEMU 原始 Excel，系统会按店铺跨文件去重并保留失败文件。",
} as const;

export async function getBulkWorkspaceDraft(customerId: string, draftId: string) {
  const [draft, validation] = await Promise.all([
    getBulkDraft(customerId, draftId),
    validateBulkDraft({ customerId, draftId }),
  ]);

  const batchIds = draft.groups.flatMap((group) => group.files.map((file) => file.batchId));
  const rows =
    batchIds.length === 0
      ? []
      : await db
          .select({
            batchId: orderImportRows.batchId,
            createdAt: orderImportBatches.createdAt,
            effectiveQuantity: orderImportRows.effectiveQuantity,
            externalOrderNo: orderImportRows.externalOrderNo,
            externalSubOrderNo: orderImportRows.externalSubOrderNo,
            fulfillmentMode: orderImportRows.fulfillmentMode,
            quantity: orderImportRows.quantity,
            resolvedSkuId: orderImportRows.resolvedSkuId,
            rowNumber: orderImportRows.rowNumber,
            status: orderImportRows.status,
            storeGroupId: orderImportBatches.storeGroupId,
          })
          .from(orderImportRows)
          .innerJoin(orderImportBatches, eq(orderImportBatches.id, orderImportRows.batchId))
          .where(inArray(orderImportRows.batchId, batchIds))
          .orderBy(asc(orderImportBatches.createdAt), asc(orderImportRows.rowNumber));

  const skuIds = [...new Set(rows.flatMap((row) => (row.resolvedSkuId ? [row.resolvedSkuId] : [])))];
  const cargoPrices = skuIds.length
    ? await db
        .select({
          id: skus.id,
          lifecycleStatus: skus.lifecycleStatus,
          unitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
        })
        .from(skus)
        .where(
          and(
            inArray(skus.id, skuIds),
            eq(skus.lifecycleStatus, "ACTIVE"),
          ),
        )
    : [];
  const priceBySku = new Map(
    cargoPrices.flatMap((row) =>
      row.unitPriceMilliYuan === null
        ? []
        : [[row.id, row.unitPriceMilliYuan] as const],
    ),
  );

  const allSubOrders = [...new Set(rows.flatMap((row) => (row.externalSubOrderNo ? [row.externalSubOrderNo] : [])))];
  const existingRows =
    allSubOrders.length === 0
      ? []
      : await db
          .select({
            externalSubOrderNo: orderLines.externalSubOrderNo,
            storeId: orderLines.storeId,
          })
          .from(orderLines)
          .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, orderLines.orderId))
          .where(
            and(
              eq(fulfillmentOrders.customerId, customerId),
              eq(orderLines.deduplicationActive, true),
              inArray(orderLines.externalSubOrderNo, allSubOrders),
            ),
          );
  const existingOrderKeys = new Set(
    existingRows.flatMap((row) =>
      row.externalSubOrderNo ? [`${row.storeId}:${row.externalSubOrderNo}`] : [],
    ),
  );

  return {
    ...draft,
    groups: draft.groups.map((group) => {
      const groupValidation = validation.groups.get(group.id);
      const groupRows = rows.filter((row) => row.storeGroupId === group.id);
      const firstBySubOrder = new Map<string, WorkspaceRow>();

      for (const row of groupRows) {
        if (!row.externalSubOrderNo || firstBySubOrder.has(row.externalSubOrderNo)) continue;
        firstBySubOrder.set(row.externalSubOrderNo, row);
      }

      let merchandiseAmountFen = 0;
      const packageOrderNumbers = new Set<string>();
      for (const row of firstBySubOrder.values()) {
        const key = `${group.storeId}:${row.externalSubOrderNo}`;
        if (
          row.status !== "READY" ||
          existingOrderKeys.has(key) ||
          !row.effectiveQuantity ||
          row.effectiveQuantity <= 0
        ) {
          continue;
        }
        if (row.externalOrderNo) {
          packageOrderNumbers.add(row.externalOrderNo);
        }
        if (row.fulfillmentMode === "SYSTEM_SKU" && row.resolvedSkuId) {
          merchandiseAmountFen += calculateLineAmountFen(
            row.effectiveQuantity,
            priceBySku.get(row.resolvedSkuId) ?? 0,
          );
        }
      }
      const { totalAmountFen } = calculateOrderPricing({
        merchandiseAmountFen,
        packageCount: packageOrderNumbers.size,
      });

      return {
        deduplicatedOrderCount: groupValidation?.deduplicatedOrderCount ?? 0,
        existingOrderCount: groupValidation?.existingOrderCount ?? 0,
        fileCount: group.files.length,
        files: group.files.map((file) => ({
          batchId: file.batchId,
          fileName: file.fileName,
          fileSizeBytes: file.fileSizeBytes,
          invalidRows: file.summary.invalid,
          rawOrderCount: file.summary.total,
          totalQuantity: file.summary.ready,
          unknownSkuRows: file.summary.unknownSku,
        })),
        groupId: group.id,
        helperText: helperTextMap[groupValidation?.status ?? "EMPTY"],
        invalidRowCount: groupValidation?.invalidRowCount ?? 0,
        rawOrderCount: groupValidation?.totalRowCount ?? 0,
        sameStoreDuplicateCount: groupValidation?.sameStoreDuplicateCount ?? 0,
        status: groupValidation?.status ?? "EMPTY",
        statusLabel: statusLabelMap[groupValidation?.status ?? "EMPTY"],
        storeId: group.storeId,
        storeName: group.storeName,
        totalAmountFen,
        totalQuantity: groupValidation?.totalQuantity ?? 0,
        unknownSkuCount: groupValidation?.unknownSkuCount ?? 0,
      };
    }),
  };
}
