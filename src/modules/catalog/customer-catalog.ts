import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import { roundMilliYuanToFen } from "./unit-price";

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
  actualUnitPriceFen: number | null;
  actualUnitPriceMilliYuan: number | null;
  availableQuantity: number;
  saleStatus: "SELLABLE" | "NOT_SELLABLE";
  orderable: boolean;
  availabilityReason:
    | "AVAILABLE"
    | "MANUALLY_UNAVAILABLE"
    | "PRICE_MISSING"
    | "SOLD_OUT";
  sellable: boolean;
};

export type CustomerCatalogItem = Omit<CustomerCatalogRecord, "sourceSequence">;

export function resolveCatalogAvailability(
  saleStatus: "SELLABLE" | "NOT_SELLABLE",
  availableQuantity: number,
  cargoUnitPriceMilliYuan: number | null,
) {
  if (saleStatus === "NOT_SELLABLE") {
    return {
      availabilityReason: "MANUALLY_UNAVAILABLE" as const,
      orderable: false,
    };
  }
  if (cargoUnitPriceMilliYuan === null) {
    return { availabilityReason: "PRICE_MISSING" as const, orderable: false };
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
  _customerId: string,
): Promise<CustomerCatalogItem[]> {
  void _customerId;
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
      actualUnitPriceMilliYuan: products.cargoUnitPriceMilliYuan,
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
    .leftJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .leftJoin(activeReservations, eq(activeReservations.skuId, skus.id))
    .where(
      and(
        eq(products.status, "ACTIVE"),
        eq(skus.lifecycleStatus, "ACTIVE"),
      ),
    )
    .orderBy(asc(skus.skuCode));

  return toCustomerCatalogItems(rows.map((row) => {
    const actualUnitPriceFen =
      row.actualUnitPriceMilliYuan === null
        ? null
        : roundMilliYuanToFen(row.actualUnitPriceMilliYuan);
    const availability = resolveCatalogAvailability(
      row.saleStatus,
      row.availableQuantity,
      row.actualUnitPriceMilliYuan,
    );
    return {
      ...row,
      actualUnitPriceFen,
      ...availability,
      sellable: availability.orderable,
    };
  }));
}
