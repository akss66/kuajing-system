import { sql } from "drizzle-orm";
import { expect, test } from "vitest";

import { db } from "@/db/client";

test("catalog and order tables expose canonical milli-yuan prices", async () => {
  const columns = await db.execute<{ columnName: string; tableName: string }>(sql`
    select table_name as "tableName", column_name as "columnName"
    from information_schema.columns
    where table_schema = 'public'
      and (table_name, column_name) in (
        ('skus', 'default_unit_price_milli_yuan'),
        ('customer_sku_prices', 'unit_price_milli_yuan'),
        ('order_lines', 'unit_price_milli_yuan')
      )
    order by table_name, column_name
  `);

  expect(columns).toEqual([
    { columnName: "unit_price_milli_yuan", tableName: "customer_sku_prices" },
    { columnName: "unit_price_milli_yuan", tableName: "order_lines" },
    { columnName: "default_unit_price_milli_yuan", tableName: "skus" },
  ]);
});

test("order line amount constraint rounds after exact-price multiplication", async () => {
  const constraints = await db.execute<{ definition: string }>(sql`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conname = 'order_lines_amount_matches_exact_price'
  `);

  expect(constraints).toHaveLength(1);
  expect(constraints[0]?.definition).toContain("unit_price_milli_yuan");
  expect(constraints[0]?.definition).toContain("line_amount_fen");
});

test("legacy fen-only catalog inserts are promoted to exact milli-yuan", async () => {
  const [product] = await db.execute<{ id: string }>(sql`
    insert into products (name)
    values ('Legacy exact-price fixture')
    returning id
  `);

  const [sku] = await db.execute<{
    defaultUnitPriceFen: number;
    defaultUnitPriceMilliYuan: number;
  }>(sql`
    insert into skus (product_id, sku_code, name, default_unit_price_fen)
    values (${product!.id}::uuid, 'LEGACY-FEN-ONLY', 'Legacy SKU', 33)
    returning
      default_unit_price_fen as "defaultUnitPriceFen",
      default_unit_price_milli_yuan as "defaultUnitPriceMilliYuan"
  `);

  expect(sku).toEqual({
    defaultUnitPriceFen: 33,
    defaultUnitPriceMilliYuan: 330,
  });
});
