import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { expect, test } from "vitest";

const baseDatabaseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
);

function splitStatements(sqlText: string) {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigrationFile(sql: postgres.Sql, fileName: string) {
  const contents = await readFile(path.join(process.cwd(), "drizzle", fileName), "utf8");
  for (const statement of splitStatements(contents)) {
    await sql.unsafe(statement);
  }
}

test("0024 backfills each legacy SKU price and enforces nonnegative SKU pricing", async () => {
  const databaseName = `tzx_sku_cargo_price_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { idle_timeout: 1, max: 1 });
  const disposableUrl = new URL(baseDatabaseUrl);
  disposableUrl.pathname = `/${databaseName}`;
  let sql: postgres.Sql | null = null;

  try {
    await admin.unsafe(`create database "${databaseName}"`);
    sql = postgres(disposableUrl.toString(), { idle_timeout: 1, max: 1 });
    await sql`create extension if not exists pgcrypto`;

    const migrations = [
      "0000_aromatic_shocker.sql",
      "0001_thin_yellow_claw.sql",
      "0002_daily_eternals.sql",
      "0003_lonely_callisto.sql",
      "0004_outstanding_phantom_reporter.sql",
      "0005_far_ghost_rider.sql",
      "0006_fearless_scorpion.sql",
      "0007_bored_grim_reaper.sql",
      "0008_absurd_nightmare.sql",
      "0009_foamy_sasquatch.sql",
      "0010_multi_store_bulk_order.sql",
      "0011_bulk_submission_requests.sql",
      "0012_settlement_timeout_review.sql",
      "0013_jifeng_reconciliation_claim.sql",
      "0014_account_governance.sql",
      "0015_jifeng_oauth_connection.sql",
      "0016_feishu_cargo_migration.sql",
      "0017_exact_sku_price.sql",
      "0018_feishu_exact_price_snapshot.sql",
      "0019_jifeng_bigint_logistics_id.sql",
      "0020_feishu_field_mapping.sql",
      "0021_inventory_movement_listing_and_stocktakes.sql",
      "0022_backfill_feishu_product_fields.sql",
      "0023_sku_lifecycle_management.sql",
    ];
    for (const migration of migrations) {
      await applyMigrationFile(sql, migration);
    }

    const [product] = await sql<{ id: string }[]>`
      insert into products (name, cargo_unit_price_milli_yuan)
      values ('Legacy grouped product', 2930)
      returning id
    `;
    await sql`
      insert into skus (
        product_id,
        sku_code,
        name,
        default_unit_price_milli_yuan,
        default_unit_price_fen
      ) values
        (${product.id}::uuid, 'TZX-001-1', 'Black', 1000, 100),
        (${product.id}::uuid, 'TZX-001-2', 'Red', 1100, 110)
    `;

    await applyMigrationFile(sql, "0024_sku_cargo_pricing.sql");

    const rows = await sql<
      { cargoUnitPriceMilliYuan: number; skuCode: string }[]
    >`
      select
        sku_code as "skuCode",
        cargo_unit_price_milli_yuan as "cargoUnitPriceMilliYuan"
      from skus
      order by sku_code asc
    `;
    expect(rows).toEqual([
      { cargoUnitPriceMilliYuan: 2930, skuCode: "TZX-001-1" },
      { cargoUnitPriceMilliYuan: 2930, skuCode: "TZX-001-2" },
    ]);

    await sql`
      update skus
      set cargo_unit_price_milli_yuan = 3100
      where sku_code = 'TZX-001-2'
    `;
    const [updated] = await sql<{ cargoUnitPriceMilliYuan: number }[]>`
      select cargo_unit_price_milli_yuan as "cargoUnitPriceMilliYuan"
      from skus
      where sku_code = 'TZX-001-2'
    `;
    expect(updated.cargoUnitPriceMilliYuan).toBe(3100);

    await expect(
      sql`
        update skus
        set cargo_unit_price_milli_yuan = -1
        where sku_code = 'TZX-001-1'
      `,
    ).rejects.toThrow(/skus_cargo_unit_price_milli_yuan_non_negative/i);
  } finally {
    if (sql) await sql.end({ timeout: 5 });
    await admin`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${databaseName}
        and pid <> pg_backend_pid()
    `;
    await admin.unsafe(`drop database if exists "${databaseName}"`);
    await admin.end({ timeout: 5 });
  }
});
