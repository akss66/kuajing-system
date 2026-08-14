import { and, eq } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { customerSkuPrices, skus } from "@/db/schema";

import type { ResolveUnitPriceInput } from "./types";
import { fenToMilliYuan } from "./unit-price";

export type ResolvedUnitPrice = {
  unitPriceFen: number;
  unitPriceMilliYuan: number;
};

export class InvalidUnitPriceError extends Error {
  constructor() {
    super("Unit price must be a non-negative integer number of fen");
    this.name = "InvalidUnitPriceError";
  }
}

export class SkuNotFoundError extends Error {
  constructor(public readonly skuId: string) {
    super(`SKU not found: ${skuId}`);
    this.name = "SkuNotFoundError";
  }
}

function assertValidUnitPrice(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidUnitPriceError();
  }
}

export async function resolveUnitPrice(
  tx: DbTransaction,
  input: ResolveUnitPriceInput,
): Promise<ResolvedUnitPrice> {
  if (input.overrideUnitPriceFen !== undefined) {
    assertValidUnitPrice(input.overrideUnitPriceFen);
    return {
      unitPriceFen: input.overrideUnitPriceFen,
      unitPriceMilliYuan: fenToMilliYuan(input.overrideUnitPriceFen),
    };
  }

  const [customerPrice] = await tx
    .select({
      unitPriceFen: customerSkuPrices.unitPriceFen,
      unitPriceMilliYuan: customerSkuPrices.unitPriceMilliYuan,
    })
    .from(customerSkuPrices)
    .where(
      and(
        eq(customerSkuPrices.customerId, input.customerId),
        eq(customerSkuPrices.skuId, input.skuId),
        eq(customerSkuPrices.active, true),
      ),
    )
    .limit(1);

  if (customerPrice) return customerPrice;

  const [sku] = await tx
    .select({
      unitPriceFen: skus.defaultUnitPriceFen,
      unitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
    })
    .from(skus)
    .where(eq(skus.id, input.skuId))
    .limit(1);

  if (!sku) throw new SkuNotFoundError(input.skuId);
  return sku;
}
