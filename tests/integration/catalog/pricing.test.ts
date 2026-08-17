import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  customerSkuPrices,
  customers,
  products,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";
import {
  MissingCargoUnitPriceError,
  resolveUnitPrice,
} from "@/modules/catalog/pricing";
import { resolveStandardSku } from "@/modules/catalog/repository";

afterEach(async () => {
  await db.delete(skuAliases);
  await db.delete(customerSkuPrices);
  await db.delete(skus);
  await db.delete(products);
  await db.delete(stores);
  await db.delete(customers);
});

async function createCatalogFixture() {
  const [customer] = await db
    .insert(customers)
    .values({ code: `CAT-${crypto.randomUUID().slice(0, 12)}`, name: "Catalog customer" })
    .returning({ id: customers.id });
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "Ottawa TEMU" })
    .returning({ id: stores.id });
  const [product] = await db
    .insert(products)
    .values({ cargoUnitPriceMilliYuan: 8_155, name: "Demo product" })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 690,
      name: "Demo red",
      productId: product.id,
      skuCode: `TZX-${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: skus.id });

  return { customer, sku, store };
}

describe("catalog cargo price", () => {
  test("database constraints reject negative stored prices", async () => {
    const fixture = await createCatalogFixture();

    await expect(
      db.insert(customerSkuPrices).values({
        customerId: fixture.customer.id,
        skuId: fixture.sku.id,
        unitPriceFen: -1,
      }),
    ).rejects.toThrow();
  });

  test("uses the product cargo price and ignores an active customer price", async () => {
    const fixture = await createCatalogFixture();
    await db.insert(customerSkuPrices).values({
      customerId: fixture.customer.id,
      skuId: fixture.sku.id,
      unitPriceFen: 760,
    });

    const actual = await db.transaction((tx) =>
      resolveUnitPrice(tx, {
        skuId: fixture.sku.id,
      }),
    );

    expect(actual).toEqual({
      unitPriceFen: 816,
      unitPriceMilliYuan: 8_155,
    });
  });

  test("uses the product cargo price instead of the SKU purchase price", async () => {
    const fixture = await createCatalogFixture();

    const actual = await db.transaction((tx) =>
      resolveUnitPrice(tx, {
        skuId: fixture.sku.id,
      }),
    );

    expect(actual).toEqual({
      unitPriceFen: 816,
      unitPriceMilliYuan: 8_155,
    });
  });

  test("never leaks another customer's active price", async () => {
    const fixture = await createCatalogFixture();
    const [otherCustomer] = await db
      .insert(customers)
      .values({
        code: `OTHER-${crypto.randomUUID().slice(0, 12)}`,
        name: "Other catalog customer",
      })
      .returning({ id: customers.id });
    await db.insert(customerSkuPrices).values({
      customerId: otherCustomer.id,
      skuId: fixture.sku.id,
      unitPriceFen: 990,
    });

    const actual = await db.transaction((tx) =>
      resolveUnitPrice(tx, {
        skuId: fixture.sku.id,
      }),
    );

    expect(actual).toEqual({
      unitPriceFen: 816,
      unitPriceMilliYuan: 8_155,
    });
  });

  test("rejects ordering when the product cargo price is missing", async () => {
    const fixture = await createCatalogFixture();
    await db.update(products).set({ cargoUnitPriceMilliYuan: null });

    await expect(
      db.transaction((tx) =>
        resolveUnitPrice(tx, {
          skuId: fixture.sku.id,
        }),
      ),
    ).rejects.toBeInstanceOf(MissingCargoUnitPriceError);
  });
});

describe("external SKU aliases", () => {
  test("a global external SKU alias is unique", async () => {
    const fixture = await createCatalogFixture();
    await db.insert(skuAliases).values({
      externalSku: "TEMU-UNIQUE",
      skuId: fixture.sku.id,
    });

    await expect(
      db.insert(skuAliases).values({
        externalSku: "TEMU-UNIQUE",
        skuId: fixture.sku.id,
      }),
    ).rejects.toThrow();
  });

  test("store-specific aliases take priority over global aliases", async () => {
    const fixture = await createCatalogFixture();
    const [otherProduct] = await db
      .insert(products)
      .values({ name: "Other product" })
      .returning({ id: products.id });
    const [otherSku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: 520,
        name: "Other blue",
        productId: otherProduct.id,
        skuCode: `TZX-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: skus.id });
    await db.insert(skuAliases).values([
      { externalSku: "TEMU-RED", skuId: otherSku.id },
      {
        externalSku: "TEMU-RED",
        skuId: fixture.sku.id,
        storeId: fixture.store.id,
      },
    ]);

    const resolved = await db.transaction((tx) =>
      resolveStandardSku(tx, {
        externalSku: "TEMU-RED",
        storeId: fixture.store.id,
      }),
    );

    expect(resolved).toBe(fixture.sku.id);
  });

  test("falls back to a global alias and never guesses unknown aliases", async () => {
    const fixture = await createCatalogFixture();
    await db.insert(skuAliases).values({
      externalSku: "TEMU-GLOBAL",
      skuId: fixture.sku.id,
    });

    const globalMatch = await db.transaction((tx) =>
      resolveStandardSku(tx, {
        externalSku: "TEMU-GLOBAL",
        storeId: fixture.store.id,
      }),
    );
    const unknownMatch = await db.transaction((tx) =>
      resolveStandardSku(tx, {
        externalSku: " temu-global ",
        storeId: fixture.store.id,
      }),
    );

    expect(globalMatch).toBe(fixture.sku.id);
    expect(unknownMatch).toBeNull();
  });
});
