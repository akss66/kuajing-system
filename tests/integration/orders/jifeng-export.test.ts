import ExcelJS from "exceljs";
import { makeSignature } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/admin/orders/jifeng-export/route";
import { db } from "@/db/client";
import {
  adminUsers,
  authSessions,
  authUsers,
  customers,
  customerUsers,
  fulfillmentOrders,
  orderLines,
  orderShipments,
  products,
  shipmentFulfillments,
  skus,
  stores,
} from "@/db/schema";
import { encryptPii } from "@/shared/pii-crypto";

async function createSessionCookie(input: {
  customerId?: string;
  role: "admin" | "user";
}) {
  const email = `jifeng-export-${crypto.randomUUID()}@tongzhouxing.local`;
  const userId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const signedSessionToken = `${sessionToken}.${await makeSignature(
    sessionToken,
    process.env.BETTER_AUTH_SECRET!,
  )}`;

  await db.insert(authUsers).values({
    ...(input.customerId ? { customerId: input.customerId } : {}),
    email,
    id: userId,
    name: input.role === "admin" ? "Export Admin" : "Export Customer",
    role: input.role,
  });

  if (input.role === "admin") {
    await db.insert(adminUsers).values({
      displayName: "Export Admin",
      loginIdentifier: email,
    });
  } else {
    await db.insert(customerUsers).values({
      customerId: input.customerId ?? crypto.randomUUID(),
      displayName: "Export Customer",
      loginIdentifier: email,
    });
  }

  await db.insert(authSessions).values({
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    id: crypto.randomUUID(),
    token: sessionToken,
    userId,
  });

  return `better-auth.session_token=${signedSessionToken}`;
}

function recipient(input: { address: string; name: string; phone: string }) {
  return {
    addressLine1: input.address,
    addressLine2: "Unit 8",
    addressLine3: null,
    alternatePhone: null,
    city: "Ottawa",
    country: "CA",
    district: null,
    email: null,
    identityNumber: null,
    name: input.name,
    phone: input.phone,
    postalCode: "K1A 0B1",
    province: "ON",
    taxNumber: null,
  };
}

async function seedExportScenario() {
  const seed = crypto.randomUUID().slice(0, 8);
  const [customer] = await db
    .insert(customers)
    .values({
      code: `EXPORT-${seed}`,
      contactName: "陆坤",
      name: "导出客户",
    })
    .returning({ id: customers.id });
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "渥太华一店" })
    .returning({ id: stores.id });
  const [product] = await db
    .insert(products)
    .values({ name: "导出商品" })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(skus)
    .values({
      declarationUnitPriceFen: 345,
      name: "纯棉收纳袋",
      productId: product.id,
      skuCode: `TZX-EXPORT-${seed}`,
    })
    .returning({ id: skus.id });
  const [selectedOrder, unselectedOrder] = await db
    .insert(fulfillmentOrders)
    .values([
      {
        customerId: customer.id,
        orderNumber: `TH-EXPORT-${seed}-A`,
        paidAt: new Date(),
        paymentMode: "DIRECT_OFFLINE",
        status: "PAID_PENDING_FULFILLMENT",
        storeId: store.id,
        totalAmountFen: 2_300,
        totalPackageCount: 2,
        totalQuantity: 4,
      },
      {
        customerId: customer.id,
        orderNumber: `TH-EXPORT-${seed}-B`,
        storeId: store.id,
        totalAmountFen: 1_800,
        totalPackageCount: 1,
        totalQuantity: 1,
      },
    ])
    .returning({ id: fulfillmentOrders.id });
  const [activeShipment, cancelledShipment, unselectedShipment, shippedShipment] = await db
    .insert(orderShipments)
    .values([
      {
        externalOrderNo: `PO-${seed}-ACTIVE`,
        orderId: selectedOrder.id,
        recipientPayloadEncrypted: encryptPii(
          recipient({
            address: "100 Main St",
            name: "Alice Chen",
            phone: "+1 613 555 0100",
          }),
        ),
        storeId: store.id,
      },
      {
        deduplicationActive: false,
        externalOrderNo: `PO-${seed}-CANCELLED-PII-SENTINEL`,
        orderId: selectedOrder.id,
        recipientPayloadEncrypted: encryptPii(
          recipient({
            address: "CANCELLED-ADDRESS-PII-SENTINEL",
            name: "Cancelled Person",
            phone: "CANCELLED-PHONE-PII-SENTINEL",
          }),
        ),
        storeId: store.id,
      },
      {
        externalOrderNo: `PO-${seed}-UNSELECTED-PII-SENTINEL`,
        orderId: unselectedOrder.id,
        recipientPayloadEncrypted: encryptPii(
          recipient({
            address: "UNSELECTED-ADDRESS-PII-SENTINEL",
            name: "Unselected Person",
            phone: "UNSELECTED-PHONE-PII-SENTINEL",
          }),
        ),
        storeId: store.id,
      },
      {
        externalOrderNo: `PO-${seed}-SHIPPED-PII-SENTINEL`,
        orderId: selectedOrder.id,
        recipientPayloadEncrypted: encryptPii(
          recipient({
            address: "SHIPPED-ADDRESS-PII-SENTINEL",
            name: "Shipped Person",
            phone: "SHIPPED-PHONE-PII-SENTINEL",
          }),
        ),
        storeId: store.id,
      },
    ])
    .returning({ id: orderShipments.id });

  await db.insert(shipmentFulfillments).values({
    erpNo: `OPNJ-${seed}`,
    shipmentId: shippedShipment.id,
    status: "SHIPPED",
  });

  await db.insert(orderLines).values([
    {
      lineAmountFen: 1_000,
      orderId: selectedOrder.id,
      quantity: 2,
      shipmentId: activeShipment.id,
      externalSku: "TEMU-ORIGINAL-001",
      skuCodeSnapshot: "TZX-001",
      skuId: sku.id,
      skuNameSnapshot: "纯棉收纳袋",
      storeId: store.id,
      unitPriceFen: 500,
      unitPriceMilliYuan: 5_000,
    },
    {
      lineAmountFen: 500,
      orderId: selectedOrder.id,
      quantity: 1,
      shipmentId: activeShipment.id,
      externalSku: "TEMU-ORIGINAL-002",
      skuCodeSnapshot: "TZX-002",
      skuId: sku.id,
      skuNameSnapshot: "旅行收纳包",
      storeId: store.id,
      unitPriceFen: 500,
      unitPriceMilliYuan: 5_000,
    },
    {
      deduplicationActive: false,
      lineAmountFen: 500,
      orderId: selectedOrder.id,
      quantity: 1,
      shipmentId: cancelledShipment.id,
      skuCodeSnapshot: "CANCELLED-SKU-SENTINEL",
      skuId: sku.id,
      skuNameSnapshot: "已取消商品",
      storeId: store.id,
      unitPriceFen: 500,
      unitPriceMilliYuan: 5_000,
    },
    {
      lineAmountFen: 500,
      orderId: unselectedOrder.id,
      quantity: 1,
      shipmentId: unselectedShipment.id,
      skuCodeSnapshot: "UNSELECTED-SKU-SENTINEL",
      skuId: sku.id,
      skuNameSnapshot: "未选择商品",
      storeId: store.id,
      unitPriceFen: 500,
      unitPriceMilliYuan: 5_000,
    },
    {
      lineAmountFen: 500,
      orderId: selectedOrder.id,
      quantity: 1,
      shipmentId: shippedShipment.id,
      skuCodeSnapshot: "SHIPPED-SKU-SENTINEL",
      skuId: sku.id,
      skuNameSnapshot: "已发货商品",
      storeId: store.id,
      unitPriceFen: 500,
      unitPriceMilliYuan: 5_000,
    },
  ]);

  return {
    activeShipmentId: activeShipment.id,
    customerId: customer.id,
    selectedOrderId: selectedOrder.id,
    skuId: sku.id,
    storeId: store.id,
    unpaidOrderId: unselectedOrder.id,
  };
}

function exportRequest(input: unknown, cookie?: string) {
  return new Request("http://127.0.0.1:3000/api/admin/orders/jifeng-export", {
    body: JSON.stringify(input),
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    method: "POST",
  });
}

afterEach(async () => {
  await db.execute(sql.raw(`
    truncate table
      order_lines,
      shipment_fulfillments,
      order_shipments,
      fulfillment_orders,
      auth_sessions,
      auth_accounts,
      auth_verifications,
      auth_users,
      customer_users,
      admin_users,
      stores,
      skus,
      products,
      customers
    restart identity cascade
  `));
});

describe("POST /api/admin/orders/jifeng-export", () => {
  test("requires an administrator", async () => {
    const response = await POST(exportRequest({ orderIds: [crypto.randomUUID()] }));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  test("rejects customer accounts and malformed order selections without details", async () => {
    const seeded = await seedExportScenario();
    const customerCookie = await createSessionCookie({
      customerId: seeded.customerId,
      role: "user",
    });
    const forbidden = await POST(
      exportRequest({ orderIds: [seeded.selectedOrderId] }, customerCookie),
    );

    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("");

    const adminCookie = await createSessionCookie({ role: "admin" });
    const malformed = await POST(
      exportRequest({ orderIds: ["not-a-uuid"] }, adminCookie),
    );
    const empty = await POST(exportRequest({ orderIds: [] }, adminCookie));
    const tooMany = await POST(
      exportRequest(
        { orderIds: Array.from({ length: 101 }, () => crypto.randomUUID()) },
        adminCookie,
      ),
    );

    expect(malformed.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(tooMany.status).toBe(400);
    expect(await malformed.text()).toBe("");
  });

  test("accepts repeated order ids after deduplication and returns 404 when nothing is exportable", async () => {
    const seeded = await seedExportScenario();
    const adminCookie = await createSessionCookie({ role: "admin" });
    const duplicated = await POST(
      exportRequest(
        { orderIds: Array.from({ length: 101 }, () => seeded.selectedOrderId) },
        adminCookie,
      ),
    );

    expect(duplicated.status).toBe(200);

    const missing = await POST(
      exportRequest({ orderIds: [crypto.randomUUID()] }, adminCookie),
    );

    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
  });

  test("refuses unpaid orders even when an administrator knows their ids", async () => {
    const seeded = await seedExportScenario();
    const adminCookie = await createSessionCookie({ role: "admin" });
    const response = await POST(
      exportRequest({ orderIds: [seeded.unpaidOrderId] }, adminCookie),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  test("deduplicates selected orders and exports only active shipment lines as XLSX", async () => {
    const seeded = await seedExportScenario();
    const adminCookie = await createSessionCookie({ role: "admin" });
    const response = await POST(
      exportRequest(
        {
          orderIds: [
            seeded.selectedOrderId,
            seeded.unpaidOrderId,
            seeded.selectedOrderId,
          ],
        },
        adminCookie,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="jifeng-shipments-\d{8}\.xlsx"$/,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const bytes = await response.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const worksheet = workbook.getWorksheet("Sheet1");

    expect(worksheet?.rowCount).toBe(3);
    expect(worksheet?.getRow(2).getCell(1).value).toMatch(/-ACTIVE$/);
    expect(worksheet?.getRow(2).getCell(2).value).toBe("陆坤");
    expect(worksheet?.getRow(1).getCell(5).value).toBe("原SKU货号");
    expect(worksheet?.getRow(2).getCell(5).value).toBe("TEMU-ORIGINAL-001");
    expect(worksheet?.getRow(2).getCell(6).value).toBe("TZX-001");
    expect(worksheet?.getRow(2).getCell(8).value).toBe(3.45);
    expect(worksheet?.getRow(2).getCell(9).value).toBe("Alice Chen");
    expect(worksheet?.getRow(3).getCell(5).value).toBe("TEMU-ORIGINAL-002");
    expect(worksheet?.getRow(3).getCell(6).value).toBe("TZX-002");

    const exportedText = JSON.stringify(
      worksheet?.getRows(1, worksheet.rowCount)?.map((row) => row.values),
    );
    expect(exportedText).not.toContain("CANCELLED-");
    expect(exportedText).not.toContain("UNSELECTED-");
    expect(exportedText).not.toContain("SHIPPED-");
  });

  test("exports one row per bundled item while repeating the immutable uploaded SKU", async () => {
    const seeded = await seedExportScenario();
    await db.insert(orderLines).values([
      {
        externalSku: "TEMU-BUNDLE-ORIGINAL",
        lineAmountFen: 1_000,
        linePosition: 2,
        orderId: seeded.selectedOrderId,
        quantity: 2,
        shipmentId: seeded.activeShipmentId,
        skuCodeSnapshot: "TZX-BUNDLE-SYSTEM",
        skuId: seeded.skuId,
        skuNameSnapshot: "捆绑系统货",
        storeId: seeded.storeId,
        unitPriceFen: 500,
        unitPriceMilliYuan: 5_000,
      },
      {
        externalSku: "TEMU-BUNDLE-ORIGINAL",
        lineAmountFen: 0,
        lineKind: "CUSTOMER_SUPPLIED",
        linePosition: 3,
        orderId: seeded.selectedOrderId,
        quantity: 3,
        shipmentId: seeded.activeShipmentId,
        skuCodeSnapshot: "CUSTOM-BUNDLE-ITEM",
        skuNameSnapshot: "客户自有货",
        storeId: seeded.storeId,
        unitPriceFen: 0,
        unitPriceMilliYuan: 0,
      },
    ]);
    const response = await POST(
      exportRequest(
        { orderIds: [seeded.selectedOrderId] },
        await createSessionCookie({ role: "admin" }),
      ),
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    const worksheet = workbook.getWorksheet("Sheet1")!;
    const bundledRows = worksheet
      .getRows(2, worksheet.rowCount - 1)!
      .filter((row) => row.getCell(5).value === "TEMU-BUNDLE-ORIGINAL");

    expect(bundledRows.map((row) => [
      row.getCell(5).value,
      row.getCell(6).value,
      row.getCell(7).value,
    ])).toEqual([
      ["TEMU-BUNDLE-ORIGINAL", "TZX-BUNDLE-SYSTEM", 2],
      ["TEMU-BUNDLE-ORIGINAL", "CUSTOM-BUNDLE-ITEM", 3],
    ]);
  });
});
