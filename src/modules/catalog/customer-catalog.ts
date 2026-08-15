import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customerSkuPrices,
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";

export type CustomerCatalogRecord = {
  id: string;
  productId: string;
  sourceSequence: string | null;
  skuCode: string;
  productName: string;
  skuName: string;
  imageUrl: string | null;
  specification: string | null;
  color: string | null;
  combination: string | null;
  weightGrams: number | null;
  linkText: string | null;
  productUrl: string | null;
  actualUnitPriceFen: number;
  actualUnitPriceMilliYuan: number;
  availableQuantity: number;
  saleStatus: "SELLABLE" | "NOT_SELLABLE";
  orderable: boolean;
  availabilityReason:
    | "AVAILABLE"
    | "MANUALLY_UNAVAILABLE"
    | "SOLD_OUT";
  sellable: boolean;
};

export type CustomerCatalogItem = Omit<CustomerCatalogRecord, "sourceSequence">;

export function resolveCatalogAvailability(
  saleStatus: "SELLABLE" | "NOT_SELLABLE",
  availableQuantity: number,
) {
  if (saleStatus === "NOT_SELLABLE") {
    return {
      availabilityReason: "MANUALLY_UNAVAILABLE" as const,
      orderable: false,
    };
  }
  if (availableQuantity <= 0) {
    return { availabilityReason: "SOLD_OUT" as const, orderable: false };
  }
  return { availabilityReason: "AVAILABLE" as const, orderable: true };
}

export function toCustomerCatalogItems(
  rows: readonly CustomerCatalogRecord[],
): CustomerCatalogItem[] {
  return rows.map((row) => {
    const { sourceSequence, ...safeRow } = row;
    void sourceSequence;
    return safeRow;
  });
}

export async function listCustomerCatalog(
  customerId: string,
): Promise<CustomerCatalogItem[]> {
  const activeReservations = db
    .select({
      quantity:
        sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`
          .mapWith(Number)
          .as("reserved_quantity"),
      skuId: inventoryReservations.skuId,
    })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.status, "ACTIVE"))
    .groupBy(inventoryReservations.skuId)
    .as("customer_catalog_active_reservations");
  const rows = await db
    .select({
      actualUnitPriceFen:
        sql<number>`coalesce(${customerSkuPrices.unitPriceFen}, ${skus.defaultUnitPriceFen})::int`.mapWith(
          Number,
        ),
      actualUnitPriceMilliYuan:
        sql<number>`coalesce(${customerSkuPrices.unitPriceMilliYuan}, ${skus.defaultUnitPriceMilliYuan})::int`.mapWith(
          Number,
        ),
      availableQuantity:
        sql<number>`greatest(coalesce(${inventoryBalances.totalQuantity}, 0) - coalesce(${activeReservations.quantity}, 0), 0)::int`.mapWith(
          Number,
        ),
      color: skus.color,
      combination: skus.combination,
      id: skus.id,
      imageUrl: skus.imageUrl,
      linkText: products.linkText,
      productId: products.id,
      productName: products.name,
      productUrl: skus.productUrl,
      saleStatus: skus.saleStatus,
      skuCode: skus.skuCode,
      skuName: skus.name,
      sourceSequence: products.sourceSequence,
      specification: skus.specification,
      weightGrams: skus.weightGrams,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .leftJoin(
      customerSkuPrices,
      and(
        eq(customerSkuPrices.skuId, skus.id),
        eq(customerSkuPrices.customerId, customerId),
        eq(customerSkuPrices.active, true),
      ),
    )
    .leftJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .leftJoin(activeReservations, eq(activeReservations.skuId, skus.id))
    .where(eq(products.status, "ACTIVE"))
    .orderBy(asc(skus.skuCode));

  return toCustomerCatalogItems(rows.map((row) => {
    const availability = resolveCatalogAvailability(
      row.saleStatus,
      row.availableQuantity,
    );
    return {
      ...row,
      ...availability,
      sellable: availability.orderable,
    };
  }));
}
