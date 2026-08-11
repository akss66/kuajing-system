import { and, eq } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { customerSkuPrices, skus } from "@/db/schema";

import type { ResolveUnitPriceInput } from "./types";

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
): Promise<number> {
  if (input.overrideUnitPriceFen !== undefined) {
    assertValidUnitPrice(input.overrideUnitPriceFen);
    return input.overrideUnitPriceFen;
  }

  const [customerPrice] = await tx
    .select({ unitPriceFen: customerSkuPrices.unitPriceFen })
    .from(customerSkuPrices)
    .where(
      and(
        eq(customerSkuPrices.customerId, input.customerId),
        eq(customerSkuPrices.skuId, input.skuId),
        eq(customerSkuPrices.active, true),
      ),
    )
    .limit(1);

  if (customerPrice) return customerPrice.unitPriceFen;

  const [sku] = await tx
    .select({ defaultUnitPriceFen: skus.defaultUnitPriceFen })
    .from(skus)
    .where(eq(skus.id, input.skuId))
    .limit(1);

  if (!sku) throw new SkuNotFoundError(input.skuId);
  return sku.defaultUnitPriceFen;
}
