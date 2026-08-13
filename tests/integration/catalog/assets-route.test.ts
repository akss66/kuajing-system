import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import { catalogAssets, customerSkuPrices, customers, products, skus } from "@/db/schema";

type AuthModule = typeof import("@/modules/identity/auth").auth;
type RouteModule = typeof import("@/app/api/catalog-assets/[assetId]/route");
type StorageModule = typeof import("@/modules/feishu/asset-storage");

async function createImageBuffer(input?: { b?: number; g?: number; r?: number }) {
  return sharp({
    create: {
      background: {
        alpha: 1,
        b: input?.b ?? 117,
        g: input?.g ?? 80,
        r: input?.r ?? 32,
      },
      channels: 4,
      height: 9,
      width: 13,
    },
  })
    .png()
    .toBuffer();
}

async function withModules<T>(
  assetDir: string,
  run: (input: {
    auth: AuthModule;
    route: RouteModule;
    storage: StorageModule;
  }) => Promise<T>,
) {
  const previousAssetDir = process.env.CATALOG_ASSET_DIR;
  process.env.CATALOG_ASSET_DIR = assetDir;
  vi.resetModules();

  try {
    const [authModule, route, storage] = await Promise.all([
      import("@/modules/identity/auth"),
      import("@/app/api/catalog-assets/[assetId]/route"),
      import("@/modules/feishu/asset-storage"),
    ]);

    return await run({
      auth: authModule.auth,
      route,
      storage,
    });
  } finally {
    if (previousAssetDir === undefined) {
      delete process.env.CATALOG_ASSET_DIR;
    } else {
      process.env.CATALOG_ASSET_DIR = previousAssetDir;
    }
    vi.resetModules();
  }
}

async function createSessionCookie(
  auth: AuthModule,
  input:
    | { customerId: string; role: "user"; scope: "customer" }
    | { role: "admin"; scope: "admin" },
) {
  const email = `${input.scope}-${crypto.randomUUID()}@tongzhouxing.local`;

  await auth.api.createUser({
    body:
      input.role === "admin"
        ? {
            email,
            name: "Catalog Admin",
            password: "valid-test-password-2026",
            role: "admin",
          }
        : {
            data: { customerId: input.customerId },
            email,
            name: "Catalog Customer",
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

async function seedCatalogAsset(storage: StorageModule) {
  const bytes = await createImageBuffer();
  const manifest = await storage.stageCatalogAsset({
    bytes,
    contentType: "image/png",
    originalFileName: "catalog.png",
    runId: "route-run",
    skuCode: "TZX-ROUTE-001",
  });
  const storageKey = await storage.commitCatalogAsset(manifest);

  const [customer] = await db
    .insert(customers)
    .values({
      code: `C-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Catalog Customer",
    })
    .returning({ id: customers.id });
  const [otherCustomer] = await db
    .insert(customers)
    .values({
      code: `X-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Other Customer",
    })
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
    .returning({ id: catalogAssets.id, storageKey: catalogAssets.storageKey });
  const [product] = await db
    .insert(products)
    .values({ name: "Asset Product" })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 699,
      imageAssetId: asset.id,
      name: "Asset SKU",
      productId: product.id,
      skuCode: `TZX-ROUTE-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning({ id: skus.id });

  await db.insert(customerSkuPrices).values({
    active: true,
    customerId: customer.id,
    skuId: sku.id,
    unitPriceFen: 799,
  });

  return { assetId: asset.id, bytes, customerId: customer.id, otherCustomerId: otherCustomer.id };
}

async function seedCustomerVisibleAsset(
  storage: StorageModule,
  input?: {
    includeCustomerPrice?: boolean;
    productStatus?: "ACTIVE" | "DISABLED";
    saleStatus?: "SELLABLE" | "NOT_SELLABLE";
    storedMimeType?: "image/jpeg" | "image/png" | "image/webp";
  },
) {
  const seed = crypto.randomUUID();
  const bytes = await createImageBuffer({
    b: Number.parseInt(seed.slice(0, 2), 16),
    g: Number.parseInt(seed.slice(2, 4), 16),
    r: Number.parseInt(seed.slice(4, 6), 16),
  });
  const manifest = await storage.stageCatalogAsset({
    bytes,
    contentType: "image/png",
    originalFileName: "customer-visible.png",
    runId: `route-run-${crypto.randomUUID().slice(0, 8)}`,
    skuCode: "TZX-CUSTOMER-001",
  });
  const storageKey = await storage.commitCatalogAsset(manifest);

  const [customer] = await db
    .insert(customers)
    .values({
      code: `C-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Visible Customer",
    })
    .returning({ id: customers.id });
  const [otherCustomer] = await db
    .insert(customers)
    .values({
      code: `X-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Other Visible Customer",
    })
    .returning({ id: customers.id });
  const [asset] = await db
    .insert(catalogAssets)
    .values({
      byteSize: manifest.byteSize,
      contentSha256: manifest.contentSha256,
      mimeType: input?.storedMimeType ?? manifest.mimeType,
      originalFileName: manifest.originalFileName,
      storageKey,
    })
    .returning({ id: catalogAssets.id });
  const [product] = await db
    .insert(products)
    .values({ name: "Visible Product", status: input?.productStatus ?? "ACTIVE" })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 699,
      imageAssetId: asset.id,
      name: "Visible SKU",
      productId: product.id,
      saleStatus: input?.saleStatus ?? "SELLABLE",
      skuCode: `TZX-VISIBLE-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning({ id: skus.id });

  if (input?.includeCustomerPrice ?? false) {
    await db.insert(customerSkuPrices).values({
      active: true,
      customerId: customer.id,
      skuId: sku.id,
      unitPriceFen: 799,
    });
  }

  return { assetId: asset.id, bytes, customerId: customer.id, otherCustomerId: otherCustomer.id };
}

afterEach(async () => {
  await db.execute(sql.raw(`
    truncate table
      auth_sessions,
      auth_accounts,
      auth_verifications,
      auth_users,
      customer_sku_prices,
      skus,
      products,
      catalog_assets,
      customers
    restart identity cascade
  `));
});

describe("catalog asset route", () => {
  test("returns 401 for unauthenticated requests", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-assets-route-"));

    try {
      await withModules(assetDir, async ({ route, storage }) => {
        const seeded = await seedCatalogAsset(storage);
        const response = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${seeded.assetId}`),
          { params: Promise.resolve({ assetId: seeded.assetId }) },
        );

        expect(response.status).toBe(401);
      });
    } finally {
      await rm(assetDir, { force: true, recursive: true });
    }
  });

  test("serves the asset to authenticated admins with safe headers", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-assets-route-"));

    try {
      await withModules(assetDir, async ({ auth, route, storage }) => {
        const seeded = await seedCatalogAsset(storage);
        const cookie = await createSessionCookie(auth, { role: "admin", scope: "admin" });
        const response = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${seeded.assetId}`, {
            headers: { cookie },
          }),
          { params: Promise.resolve({ assetId: seeded.assetId }) },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), seeded.bytes)).toBe(0);
      });
    } finally {
      await rm(assetDir, { force: true, recursive: true });
    }
  });

  test("serves catalog-visible assets to authenticated customers", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-assets-route-"));

    try {
      await withModules(assetDir, async ({ auth, route, storage }) => {
        const seeded = await seedCatalogAsset(storage);
        const ownerCookie = await createSessionCookie(auth, {
          customerId: seeded.customerId,
          role: "user",
          scope: "customer",
        });
        const otherCookie = await createSessionCookie(auth, {
          customerId: seeded.otherCustomerId,
          role: "user",
          scope: "customer",
        });

        const ownerResponse = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${seeded.assetId}`, {
            headers: { cookie: ownerCookie },
          }),
          { params: Promise.resolve({ assetId: seeded.assetId }) },
        );
        const otherResponse = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${seeded.assetId}`, {
            headers: { cookie: otherCookie },
          }),
          { params: Promise.resolve({ assetId: seeded.assetId }) },
        );

        expect(ownerResponse.status).toBe(200);
        expect(otherResponse.status).toBe(200);
        expect(Buffer.compare(Buffer.from(await ownerResponse.arrayBuffer()), seeded.bytes)).toBe(0);
        expect(Buffer.compare(Buffer.from(await otherResponse.arrayBuffer()), seeded.bytes)).toBe(0);
      });
    } finally {
      await rm(assetDir, { force: true, recursive: true });
    }
  });

  test("serves a customer-visible asset even without a customer-specific price row", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-assets-route-"));

    try {
      await withModules(assetDir, async ({ auth, route, storage }) => {
        const seeded = await seedCustomerVisibleAsset(storage, {
          includeCustomerPrice: false,
          storedMimeType: "image/jpeg",
        });
        const ownerCookie = await createSessionCookie(auth, {
          customerId: seeded.customerId,
          role: "user",
          scope: "customer",
        });

        const response = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${seeded.assetId}`, {
            headers: { cookie: ownerCookie },
          }),
          { params: Promise.resolve({ assetId: seeded.assetId }) },
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), seeded.bytes)).toBe(0);
      });
    } finally {
      await rm(assetDir, { force: true, recursive: true });
    }
  });

  test("hides inactive and not-sellable assets from customers with a unified 404", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-assets-route-"));

    try {
      await withModules(assetDir, async ({ auth, route, storage }) => {
        const inactive = await seedCustomerVisibleAsset(storage, {
          includeCustomerPrice: true,
          productStatus: "DISABLED",
        });
        const notSellable = await seedCustomerVisibleAsset(storage, {
          includeCustomerPrice: true,
          saleStatus: "NOT_SELLABLE",
        });
        const ownerCookie = await createSessionCookie(auth, {
          customerId: inactive.customerId,
          role: "user",
          scope: "customer",
        });

        const inactiveResponse = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${inactive.assetId}`, {
            headers: { cookie: ownerCookie },
          }),
          { params: Promise.resolve({ assetId: inactive.assetId }) },
        );
        const notSellableResponse = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${notSellable.assetId}`, {
            headers: { cookie: ownerCookie },
          }),
          { params: Promise.resolve({ assetId: notSellable.assetId }) },
        );

        expect(inactiveResponse.status).toBe(404);
        expect(notSellableResponse.status).toBe(404);
      });
    } finally {
      await rm(assetDir, { force: true, recursive: true });
    }
  });

  test("returns 404 for unknown asset ids without leaking paths", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "catalog-assets-route-"));

    try {
      await withModules(assetDir, async ({ auth, route }) => {
        const cookie = await createSessionCookie(auth, { role: "admin", scope: "admin" });
        const unknownId = crypto.randomUUID();
        const response = await route.GET(
          new Request(`http://127.0.0.1:3000/api/catalog-assets/${unknownId}`, {
            headers: { cookie },
          }),
          { params: Promise.resolve({ assetId: unknownId }) },
        );

        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(assetDir);
      });
    } finally {
      await rm(assetDir, { force: true, recursive: true });
    }
  });
});
