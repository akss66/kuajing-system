import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";

export type AdminCatalogItem = {
  id: string;
  productId: string;
  sourceSequence: string | null;
  skuCode: string;
  imageUrl: string | null;
  productName: string;
  specification: string | null;
  color: string | null;
  combination: string | null;
  weightGrams: number | null;
  defaultUnitPriceMilliYuan: number;
  totalQuantity: number;
  availableQuantity: number;
  cargoUnitPriceMilliYuan: number | null;
  saleStatus: "SELLABLE" | "NOT_SELLABLE";
  linkText: string | null;
  lifecycleStatus?: "ACTIVE" | "ARCHIVED";
  archiveReason?: string | null;
  productUrl: string | null;
};

export async function listAdminCatalog(options: { lifecycle?: "ACTIVE" | "ARCHIVED" } = {}): Promise<AdminCatalogItem[]> {
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
    .as("admin_catalog_active_reservations");

  return db
    .select({
      availableQuantity:
        sql<number>`greatest(coalesce(${inventoryBalances.totalQuantity}, 0) - coalesce(${activeReservations.quantity}, 0), 0)::int`.mapWith(
          Number,
        ),
      cargoUnitPriceMilliYuan: products.cargoUnitPriceMilliYuan,
      color: skus.color,
      combination: skus.combination,
      defaultUnitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
      id: skus.id,
      imageUrl: skus.imageUrl,
      linkText: products.linkText,
      lifecycleStatus: skus.lifecycleStatus,
      archiveReason: skus.archiveReason,
      productId: products.id,
      productName: products.name,
      productUrl: skus.productUrl,
      saleStatus: skus.saleStatus,
      skuCode: skus.skuCode,
      sourceSequence: products.sourceSequence,
      specification: skus.specification,
      totalQuantity:
        sql<number>`coalesce(${inventoryBalances.totalQuantity}, 0)::int`.mapWith(
          Number,
        ),
      weightGrams: skus.weightGrams,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .leftJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .leftJoin(activeReservations, eq(activeReservations.skuId, skus.id))
    .where(eq(skus.lifecycleStatus, options.lifecycle ?? "ACTIVE"))
    .orderBy(asc(skus.skuCode));
}
