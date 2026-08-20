import { sql } from "drizzle-orm";
import { expect, test } from "vitest";

import { db } from "@/db/client";
import { products, skus } from "@/db/schema";
import { listAdminCatalog } from "@/modules/catalog/admin-catalog";

test("SKU default prices are nullable as a pair", async () => {
  const [product] = await db
    .insert(products)
    .values({ name: "待补价商品", sourceSequence: "990" })
    .returning({ id: products.id });

  const [draft] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan: null,
      defaultUnitPriceFen: null,
      defaultUnitPriceMilliYuan: null,
      name: "待补价 SKU",
      productId: product.id,
      saleStatus: "NOT_SELLABLE",
      skuCode: "TZX-990",
    })
    .returning({
      defaultUnitPriceFen: skus.defaultUnitPriceFen,
      defaultUnitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
    });

  expect(draft).toEqual({
    defaultUnitPriceFen: null,
    defaultUnitPriceMilliYuan: null,
  });
  expect(await listAdminCatalog()).toEqual([
    expect.objectContaining({
      defaultUnitPriceMilliYuan: null,
      saleStatus: "NOT_SELLABLE",
      skuCode: "TZX-990",
    }),
  ]);

  await expect(db.execute(sql`
    update skus
    set default_unit_price_milli_yuan = 1000,
        default_unit_price_fen = null
    where sku_code = 'TZX-990'
  `)).rejects.toThrow();

  const [legacyCompatible] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 123,
      name: "旧调用方 SKU",
      productId: product.id,
      saleStatus: "NOT_SELLABLE",
      skuCode: "TZX-990-2",
    })
    .returning({
      defaultUnitPriceFen: skus.defaultUnitPriceFen,
      defaultUnitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
    });
  expect(legacyCompatible).toEqual({
    defaultUnitPriceFen: 123,
    defaultUnitPriceMilliYuan: 1_230,
  });
});
