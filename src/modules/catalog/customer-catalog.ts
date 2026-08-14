import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  customerSkuPrices,
  inventoryBalances,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";

export type CustomerCatalogItem = {
  id: string;
  skuCode: string;
  productName: string;
  skuName: string;
  imageUrl: string | null;
  specification: string | null;
  actualUnitPriceFen: number;
  actualUnitPriceMilliYuan: number;
  availableQuantity: number;
  sellable: boolean;
};

export async function listCustomerCatalog(
  customerId: string,
): Promise<CustomerCatalogItem[]> {
  const [skuRows, priceRows, balanceRows, reservationRows] = await Promise.all([
    db
      .select({
        defaultUnitPriceFen: skus.defaultUnitPriceFen,
        defaultUnitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
        id: skus.id,
        imageUrl: skus.imageUrl,
        productName: products.name,
        skuCode: skus.skuCode,
        skuName: skus.name,
        specification: skus.specification,
      })
      .from(skus)
      .innerJoin(products, eq(products.id, skus.productId))
      .where(
        and(eq(skus.saleStatus, "SELLABLE"), eq(products.status, "ACTIVE")),
      ),
    db
      .select({
        skuId: customerSkuPrices.skuId,
        unitPriceFen: customerSkuPrices.unitPriceFen,
        unitPriceMilliYuan: customerSkuPrices.unitPriceMilliYuan,
      })
      .from(customerSkuPrices)
      .where(
        and(
          eq(customerSkuPrices.customerId, customerId),
          eq(customerSkuPrices.active, true),
        ),
      ),
    db
      .select({ skuId: inventoryBalances.skuId, totalQuantity: inventoryBalances.totalQuantity })
      .from(inventoryBalances),
    db
      .select({
        quantity: sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)`.mapWith(Number),
        skuId: inventoryReservations.skuId,
      })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.status, "ACTIVE"))
      .groupBy(inventoryReservations.skuId),
  ]);

  const prices = new Map(priceRows.map((row) => [row.skuId, row]));
  const balances = new Map(balanceRows.map((row) => [row.skuId, row.totalQuantity]));
  const reservations = new Map(
    reservationRows.map((row) => [row.skuId, row.quantity]),
  );

  return skuRows.map((row) => {
    const availableQuantity = Math.max(
      0,
      (balances.get(row.id) ?? 0) - (reservations.get(row.id) ?? 0),
    );
    const customerPrice = prices.get(row.id);
    return {
      actualUnitPriceFen: customerPrice?.unitPriceFen ?? row.defaultUnitPriceFen,
      actualUnitPriceMilliYuan:
        customerPrice?.unitPriceMilliYuan ?? row.defaultUnitPriceMilliYuan,
      availableQuantity,
      id: row.id,
      imageUrl: row.imageUrl,
      productName: row.productName,
      sellable: availableQuantity > 0,
      skuCode: row.skuCode,
      skuName: row.skuName,
      specification: row.specification,
    };
  });
}
