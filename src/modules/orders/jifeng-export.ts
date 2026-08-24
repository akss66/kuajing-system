import ExcelJS from "exceljs";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import {
  customers,
  fulfillmentOrders,
  orderLines,
  orderShipments,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import { decryptPii } from "@/shared/pii-crypto";
import {
  JIFENG_EXPORTABLE_ORDER_STATUSES,
  JIFENG_EXPORTABLE_SHIPMENT_STATUSES,
} from "./jifeng-export-policy";

export const JIFENG_EXPORT_HEADERS = [
  "订单号",
  "个人姓名",
  "店铺名称",
  "商品中文名称",
  "SKU货号",
  "应履约件数",
  "申报单价",
  "收件人姓名",
  "收件人电话",
  "收件人城市",
  "收件人省/州",
  "收件人邮编",
  "收件人国家",
  "详细地址1",
  "详细地址2",
  "物流产品(产品编号)",
] as const;

const TEMPLATE_COLUMN_WIDTHS = [
  24.625, 11.875, 11.875, 17.375, 12.625, 14.625, 12.625, 14.625,
  14.625, 14.625, 15.125, 14.625, 14.625, 14.625, 17.375, 24,
] as const;

const REQUIRED_HEADER_COLUMNS = new Set([2, 3, 4, 5, 6, 15]);

const recipientSchema = z.object({
  addressLine1: z.string(),
  addressLine2: z.string().nullable().optional(),
  addressLine3: z.string().nullable().optional(),
  city: z.string(),
  country: z.string(),
  district: z.string().nullable().optional(),
  name: z.string(),
  phone: z.string(),
  postalCode: z.string(),
  province: z.string(),
});

export type JifengExportRow = {
  addressLine1: string;
  addressLine2: string;
  city: string;
  country: string;
  customerName: string;
  declarationUnitPriceFen: number | null;
  externalOrderNo: string;
  logisticsProductCode: string;
  phone: string;
  postalCode: string;
  province: string;
  quantity: number;
  recipientName: string;
  skuCode: string;
  skuName: string;
  storeName: string;
};

export class JifengExportError extends Error {
  constructor(public readonly code: "NO_EXPORTABLE_SHIPMENTS") {
    super(code);
    this.name = "JifengExportError";
  }
}

export async function buildJifengExportWorkbook(
  rows: readonly JifengExportRow[],
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.columns = TEMPLATE_COLUMN_WIDTHS.map((width) => ({ width }));

  const header = worksheet.addRow([...JIFENG_EXPORT_HEADERS]);
  header.height = 32;
  header.eachCell((cell, columnNumber) => {
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      bottom: { color: { argb: "FF000000" }, style: "thin" },
      left: { color: { argb: "FF000000" }, style: "thin" },
      right: { color: { argb: "FF000000" }, style: "thin" },
      top: { color: { argb: "FF000000" }, style: "thin" },
    };
    cell.fill = {
      fgColor: { argb: "FFC0C0C0" },
      pattern: "solid",
      type: "pattern",
    };
    cell.font = {
      bold: true,
      color: REQUIRED_HEADER_COLUMNS.has(columnNumber)
        ? { argb: "FFFF0000" }
        : { argb: "FF000000" },
      name: "宋体",
      size: 14,
    };
  });
  header.getCell(6).numFmt = "0_ ";

  for (const row of rows) {
    const worksheetRow = worksheet.addRow([
      row.externalOrderNo,
      row.customerName,
      row.storeName,
      row.skuName,
      row.skuCode,
      row.quantity,
      row.declarationUnitPriceFen === null
        ? ""
        : row.declarationUnitPriceFen / 100,
      row.recipientName,
      row.phone,
      row.city,
      row.province,
      row.postalCode,
      row.country,
      row.addressLine1,
      row.addressLine2,
      row.logisticsProductCode,
    ]);
    worksheetRow.getCell(6).numFmt = "0";
    worksheetRow.getCell(7).numFmt = "0.00";
  }

  return workbook.xlsx.writeBuffer();
}

export async function exportJifengOrdersToXlsx(input: {
  orderIds: readonly string[];
}): Promise<ArrayBuffer> {
  const { db } = await import("@/db/client");
  const rawRows = await db
    .select({
      addressPayload: orderShipments.recipientPayloadEncrypted,
      customerContactName: customers.contactName,
      customerName: customers.name,
      declarationUnitPriceFen: skus.declarationUnitPriceFen,
      externalOrderNo: orderShipments.externalOrderNo,
      lineCreatedAt: orderLines.createdAt,
      lineId: orderLines.id,
      orderId: fulfillmentOrders.id,
      quantity: orderLines.quantity,
      shipmentCreatedAt: orderShipments.createdAt,
      skuCode: orderLines.skuCodeSnapshot,
      skuName: orderLines.skuNameSnapshot,
      storeName: stores.name,
    })
    .from(orderLines)
    .innerJoin(orderShipments, eq(orderShipments.id, orderLines.shipmentId))
    .innerJoin(fulfillmentOrders, eq(fulfillmentOrders.id, orderLines.orderId))
    .leftJoin(
      shipmentFulfillments,
      eq(shipmentFulfillments.shipmentId, orderShipments.id),
    )
    .innerJoin(customers, eq(customers.id, fulfillmentOrders.customerId))
    .innerJoin(stores, eq(stores.id, fulfillmentOrders.storeId))
    .leftJoin(skus, eq(skus.id, orderLines.skuId))
    .where(
      and(
        inArray(fulfillmentOrders.id, [...input.orderIds]),
        inArray(fulfillmentOrders.status, [...JIFENG_EXPORTABLE_ORDER_STATUSES]),
        eq(orderShipments.deduplicationActive, true),
        eq(orderLines.deduplicationActive, true),
        or(
          isNull(shipmentFulfillments.id),
          inArray(shipmentFulfillments.status, [
            ...JIFENG_EXPORTABLE_SHIPMENT_STATUSES,
          ]),
        ),
      ),
    )
    .orderBy(
      asc(orderShipments.createdAt),
      asc(orderLines.createdAt),
      asc(orderLines.skuCodeSnapshot),
      asc(orderLines.id),
    );

  if (rawRows.length === 0) {
    throw new JifengExportError("NO_EXPORTABLE_SHIPMENTS");
  }

  const orderPosition = new Map(
    input.orderIds.map((orderId, index) => [orderId, index]),
  );
  rawRows.sort((left, right) => {
    const orderDifference =
      (orderPosition.get(left.orderId) ?? Number.MAX_SAFE_INTEGER) -
      (orderPosition.get(right.orderId) ?? Number.MAX_SAFE_INTEGER);
    if (orderDifference !== 0) return orderDifference;
    const shipmentDifference =
      left.shipmentCreatedAt.getTime() - right.shipmentCreatedAt.getTime();
    if (shipmentDifference !== 0) return shipmentDifference;
    const lineDifference = left.lineCreatedAt.getTime() - right.lineCreatedAt.getTime();
    if (lineDifference !== 0) return lineDifference;
    const skuDifference = left.skuCode.localeCompare(right.skuCode);
    return skuDifference !== 0 ? skuDifference : left.lineId.localeCompare(right.lineId);
  });

  const rows = rawRows.map((rawRow): JifengExportRow => {
    const recipient = recipientSchema.parse(decryptPii(rawRow.addressPayload));
    const addressLine2 = [
      recipient.addressLine2,
      recipient.addressLine3,
      recipient.district,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join(" ");

    return {
      addressLine1: recipient.addressLine1,
      addressLine2,
      city: recipient.city,
      country: recipient.country,
      customerName: rawRow.customerContactName?.trim() || rawRow.customerName,
      declarationUnitPriceFen: rawRow.declarationUnitPriceFen,
      externalOrderNo: rawRow.externalOrderNo,
      logisticsProductCode: "",
      phone: recipient.phone,
      postalCode: recipient.postalCode,
      province: recipient.province,
      quantity: rawRow.quantity,
      recipientName: recipient.name,
      skuCode: rawRow.skuCode,
      skuName: rawRow.skuName,
      storeName: rawRow.storeName,
    };
  });

  return buildJifengExportWorkbook(rows);
}
