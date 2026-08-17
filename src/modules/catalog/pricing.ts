import { and, eq } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { products, skus } from "@/db/schema";

import type { ResolveUnitPriceInput } from "./types";
import { roundMilliYuanToFen } from "./unit-price";

export type ResolvedUnitPrice = {
  unitPriceFen: number;
  unitPriceMilliYuan: number;
};

export class MissingCargoUnitPriceError extends Error {
  constructor(public readonly skuId: string) {
    super(`Cargo unit price is missing for SKU: ${skuId}`);
    this.name = "MissingCargoUnitPriceError";
  }
}

export class SkuNotFoundError extends Error {
  constructor(public readonly skuId: string) {
    super(`SKU not found: ${skuId}`);
    this.name = "SkuNotFoundError";
  }
}

export async function resolveUnitPrice(
  tx: DbTransaction,
  input: ResolveUnitPriceInput,
): Promise<ResolvedUnitPrice> {
  const [sku] = await tx
    .select({
      unitPriceMilliYuan: products.cargoUnitPriceMilliYuan,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .where(
      and(
        eq(skus.id, input.skuId),
        eq(skus.lifecycleStatus, "ACTIVE"),
      ),
    )
    .limit(1);

  if (!sku) throw new SkuNotFoundError(input.skuId);
  if (sku.unitPriceMilliYuan === null) {
    throw new MissingCargoUnitPriceError(input.skuId);
  }
  return {
    unitPriceFen: roundMilliYuanToFen(sku.unitPriceMilliYuan),
    unitPriceMilliYuan: sku.unitPriceMilliYuan,
  };
}
