import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import {
  catalogAssets,
  customerSkuPrices,
  customers,
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import { listCustomerCatalog } from "@/modules/catalog/customer-catalog";

type AuthModule = typeof import("@/modules/identity/auth").auth;
type RouteModule = typeof import("@/app/api/catalog-assets/[assetId]/route");
type StorageModule = typeof import("@/modules/feishu/asset-storage");

async function createSessionCookie(auth: AuthModule, customerId: string) {
  const email = `catalog-query-${crypto.randomUUID()}@tongzhouxing.local`;

  await auth.api.createUser({
    body: {
      data: { customerId },
      email,
      name: "Catalog Query Customer",
      password: "valid-test-password-2026",
      role: "user",
    },
  });

  const response = await auth.handler(
    new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "valid-test-password-2026" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  return (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
}

async function createQueryFixture() {
  const [customer, otherCustomer] = await db
    .insert(customers)
    .values([
      { code: "CAT-QUERY-A", name: "Catalog query A" },
      { code: "CAT-QUERY-B", name: "Catalog query B" },
    ])
    .returning({ id: customers.id });
  const [product] = await db
    .insert(products)
    .values({
      cargoUnitPriceMilliYuan: 1_366,
      linkText: "查看货品详情",
      name: "多变体商品",
      sourceSequence: "34",
    })
    .returning({ id: products.id });
  const createdSkus = await db
    .insert(skus)
    .values([
      {
        color: "赤陶红",
        combination: "单件装",
        defaultUnitPriceFen: 33,
        defaultUnitPriceMilliYuan: 325,
        imageUrl: "/api/catalog-assets/available-image",
        name: "SKU 内部名称 A",
        productId: product.id,
        productUrl: "https://example.com/products/34-a",
        skuCode: "TZX-034-1",
        specification: "55 厘米长款",
        weightGrams: 480,
      },
      {
        color: "雾霾蓝",
        combination: "两件装",
        defaultUnitPriceFen: 46,
        defaultUnitPriceMilliYuan: 455,
        imageUrl: "/api/catalog-assets/manual-image",
        name: "SKU 内部名称 B",
        productId: product.id,
        productUrl: "https://example.com/products/34-b",
        saleStatus: "NOT_SELLABLE" as const,
        skuCode: "TZX-034-2",
        specification: "70 厘米加长款",
        weightGrams: 620,
      },
      {
        color: "岩石灰",
        combination: "三件装",
        defaultUnitPriceFen: 58,
        defaultUnitPriceMilliYuan: 575,
        imageUrl: "/api/catalog-assets/sold-out-image",
        name: "SKU 内部名称 C",
        productId: product.id,
        productUrl: "https://example.com/products/34-c",
        skuCode: "TZX-034-3",
        specification: "90 厘米特长款",
        weightGrams: 790,
      },
    ])
    .returning({ id: skus.id, skuCode: skus.skuCode });
  const skuByCode = new Map(createdSkus.map((sku) => [sku.skuCode, sku.id]));

  await db.insert(inventoryBalances).values([
    { skuId: skuByCode.get("TZX-034-1")!, totalQuantity: 10 },
    { skuId: skuByCode.get("TZX-034-2")!, totalQuantity: 5 },
    { skuId: skuByCode.get("TZX-034-3")!, totalQuantity: 2 },
  ]);
  await db.insert(inventoryReservations).values([
    {
      quantity: 3,
      referenceId: "catalog-query-active",
      referenceType: "ORDER",
      skuId: skuByCode.get("TZX-034-1")!,
      status: "ACTIVE",
    },
    {
      quantity: 4,
      referenceId: "catalog-query-released",
      referenceType: "ORDER",
      skuId: skuByCode.get("TZX-034-1")!,
      status: "RELEASED",
    },
    {
      quantity: 5,
      referenceId: "catalog-query-over-reserved",
      referenceType: "ORDER",
      skuId: skuByCode.get("TZX-034-3")!,
      status: "ACTIVE",
    },
  ]);
  await db.insert(customerSkuPrices).values([
    {
      customerId: customer.id,
      skuId: skuByCode.get("TZX-034-1")!,
      unitPriceFen: 78,
      unitPriceMilliYuan: 775,
    },
    {
      customerId: otherCustomer.id,
      skuId: skuByCode.get("TZX-034-1")!,
      unitPriceFen: 100,
      unitPriceMilliYuan: 999,
    },
  ]);

  return { customer, otherCustomer };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await db.execute(sql.raw(`
    truncate table
      auth_sessions,
      auth_accounts,
      auth_verifications,
      auth_users,
      customer_sku_prices,
      inventory_reservations,
      inventory_balances,
      skus,
      products,
      catalog_assets,
      customers
    restart identity cascade
  `));
});

describe("audience-separated catalog queries", () => {
  test("returns customer-safe rows with isolated prices and independent availability facts", async () => {
    const fixture = await createQueryFixture();

    const customerRows = await listCustomerCatalog(fixture.customer.id);
    const otherCustomerRows = await listCustomerCatalog(fixture.otherCustomer.id);

    expect(customerRows.map((row) => [row.skuCode, row.availabilityReason])).toEqual([
      ["TZX-034-1", "AVAILABLE"],
      ["TZX-034-2", "MANUALLY_UNAVAILABLE"],
      ["TZX-034-3", "SOLD_OUT"],
    ]);
    expect(customerRows[0]).toMatchObject({
      actualUnitPriceMilliYuan: 775,
      availableQuantity: 7,
      color: "赤陶红",
      combination: "单件装",
      linkText: "查看货品详情",
      orderable: true,
      productUrl: "https://example.com/products/34-a",
      saleStatus: "SELLABLE",
      specification: "55 厘米长款",
      weightGrams: 480,
    });
    expect(customerRows[0].specification).not.toBe(customerRows[0].skuName);
    expect(customerRows[1]).toMatchObject({
      availableQuantity: 5,
      orderable: false,
      saleStatus: "NOT_SELLABLE",
    });
    expect(customerRows[2]).toMatchObject({
      availableQuantity: 0,
      orderable: false,
      saleStatus: "SELLABLE",
    });
    expect(otherCustomerRows[0].actualUnitPriceMilliYuan).toBe(999);
    for (const row of customerRows) {
      expect(row).not.toHaveProperty("cargoUnitPriceMilliYuan");
      expect(row).not.toHaveProperty("defaultUnitPriceMilliYuan");
      expect(row).not.toHaveProperty("sourceSequence");
      expect(row).not.toHaveProperty("totalQuantity");
    }
  });

  test("returns complete admin facts without conflating active reservations with total inventory", async () => {
    await createQueryFixture();
    const { listAdminCatalog } = await import("@/modules/catalog/admin-catalog");

    const adminRows = await listAdminCatalog();

    expect(adminRows).toHaveLength(3);
    expect(adminRows.find((row) => row.skuCode === "TZX-034-1")).toMatchObject({
      availableQuantity: 7,
      cargoUnitPriceMilliYuan: 1_366,
      color: "赤陶红",
      combination: "单件装",
      defaultUnitPriceMilliYuan: 325,
      imageUrl: "/api/catalog-assets/available-image",
      linkText: "查看货品详情",
      productName: "多变体商品",
      productUrl: "https://example.com/products/34-a",
      saleStatus: "SELLABLE",
      sourceSequence: "34",
      specification: "55 厘米长款",
      totalQuantity: 10,
      weightGrams: 480,
    });
  });

  test("serves a manual-unavailable SKU image to an authenticated customer only", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-query-assets-"));
    const previousAssetDir = process.env.CATALOG_ASSET_DIR;
    process.env.CATALOG_ASSET_DIR = assetDir;
    vi.resetModules();

    try {
      const [{ auth }, route, storage] = await Promise.all([
        import("@/modules/identity/auth"),
        import("@/app/api/catalog-assets/[assetId]/route"),
        import("@/modules/feishu/asset-storage"),
      ] satisfies [Promise<{ auth: AuthModule }>, Promise<RouteModule>, Promise<StorageModule>]);
      const bytes = await sharp({
        create: {
          background: { alpha: 1, b: 120, g: 80, r: 40 },
          channels: 4,
          height: 8,
          width: 12,
        },
      })
        .png()
        .toBuffer();
      const manifest = await storage.stageCatalogAsset({
        bytes,
        contentType: "image/png",
        originalFileName: "manual-unavailable.png",
        runId: "catalog-query-route",
        skuCode: "TZX-034-2",
      });
      const storageKey = await storage.commitCatalogAsset(manifest);
      const [customer] = await db
        .insert(customers)
        .values({ code: "CAT-IMAGE", name: "Catalog image customer" })
        .returning({ id: customers.id });
      const [asset] = await db
        .insert(catalogAssets)
        .values({
          byteSize: manifest.byteSize,
          contentSha256: manifest.contentSha256,
          mimeType: manifest.mimeType,
          originalFileName: manifest.originalFileName,
          storageKey,
        })
        .returning({ id: catalogAssets.id });
      const [product] = await db
        .insert(products)
        .values({ name: "Manual unavailable image product" })
        .returning({ id: products.id });
      await db.insert(skus).values({
        defaultUnitPriceFen: 33,
        defaultUnitPriceMilliYuan: 325,
        imageAssetId: asset.id,
        imageUrl: `/api/catalog-assets/${asset.id}`,
        name: "Manual unavailable image SKU",
        productId: product.id,
        saleStatus: "NOT_SELLABLE",
        skuCode: "TZX-034-2",
      });
      const cookie = await createSessionCookie(auth, customer.id);
      const url = `http://127.0.0.1:3000/api/catalog-assets/${asset.id}`;

      const unauthenticatedResponse = await route.GET(new Request(url), {
        params: Promise.resolve({ assetId: asset.id }),
      });
      const authenticatedResponse = await route.GET(
        new Request(url, { headers: { cookie } }),
        { params: Promise.resolve({ assetId: asset.id }) },
      );

      expect(unauthenticatedResponse.status).toBe(401);
      expect(authenticatedResponse.status).toBe(200);
      expect(
        Buffer.compare(Buffer.from(await authenticatedResponse.arrayBuffer()), bytes),
      ).toBe(0);
    } finally {
      if (previousAssetDir === undefined) {
        delete process.env.CATALOG_ASSET_DIR;
      } else {
        process.env.CATALOG_ASSET_DIR = previousAssetDir;
      }
      vi.resetModules();
      await rm(assetDir, { force: true, recursive: true });
    }
  });
});
