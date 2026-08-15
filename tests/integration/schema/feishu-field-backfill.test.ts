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
  for (const statement of splitStatements(contents)) await sql.unsafe(statement);
}

const migrations = [
  "0000_aromatic_shocker.sql", "0001_thin_yellow_claw.sql", "0002_daily_eternals.sql",
  "0003_lonely_callisto.sql", "0004_outstanding_phantom_reporter.sql", "0005_far_ghost_rider.sql",
  "0006_fearless_scorpion.sql", "0007_bored_grim_reaper.sql", "0008_absurd_nightmare.sql",
  "0009_foamy_sasquatch.sql", "0010_multi_store_bulk_order.sql", "0011_bulk_submission_requests.sql",
  "0012_settlement_timeout_review.sql", "0013_jifeng_reconciliation_claim.sql", "0014_account_governance.sql",
  "0015_jifeng_oauth_connection.sql", "0016_feishu_cargo_migration.sql", "0017_exact_sku_price.sql",
  "0018_feishu_exact_price_snapshot.sql", "0019_jifeng_bigint_logistics_id.sql",
  "0020_feishu_field_mapping.sql", "0021_inventory_movement_listing_and_stocktakes.sql",
];

function legacyRow(input: {
  cargoUnitPriceMilliYuan?: number;
  linkText: string;
  productGroupKey: string;
  skuCode: string;
}) {
  return {
    defaultUnitPriceFen: 100,
    defaultUnitPriceMilliYuan: 1000,
    linkText: input.linkText,
    productGroupKey: input.productGroupKey,
    productName: `Legacy ${input.productGroupKey}`,
    productUrl: `https://example.test/${input.productGroupKey}`,
    saleStatus: "SELLABLE",
    skuCode: input.skuCode,
    sourceRowNumber: 2,
    specification: null,
    totalQuantity: 1,
    weightGrams: null,
    ...(input.cargoUnitPriceMilliYuan === undefined
      ? {}
      : { cargoUnitPriceMilliYuan: input.cargoUnitPriceMilliYuan }),
  };
}

test("0022 backfills only complete legacy sibling groups and preserves manual parent values", async () => {
  const databaseName = `tzx_feishu_backfill_${randomUUID().replaceAll("-", "")}`;
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
    for (const migration of migrations) await applyMigrationFile(sql, migration);

    const [complete, partial, partialSibling, manual] = await sql<{ id: string }[]>`
      insert into products (name, source_sequence, link_text, cargo_unit_price_milli_yuan)
      values
        ('Complete', null, null, null),
        ('Partial', null, null, null),
        ('Partial sibling', null, null, null),
        ('Manual', 'manual-sequence', 'manual link', 999)
      returning id
    `;
    await sql`
      insert into skus (product_id, sku_code, name, default_unit_price_fen, default_unit_price_milli_yuan)
      values
        (${complete.id}::uuid, 'TZX-035-1', 'one', 100, 1000),
        (${complete.id}::uuid, 'TZX-035-2', 'two', 100, 1000),
        (${partial.id}::uuid, 'TZX-034-1', 'partial one', 100, 1000),
        (${partialSibling.id}::uuid, 'TZX-034-2', 'partial two', 100, 1000),
        (${manual.id}::uuid, 'TZX-036-1', 'manual sku', 100, 1000)
    `;
    const [adminUser] = await sql<{ id: string }[]>`
      insert into admin_users (login_identifier, display_name, status)
      values ('backfill-admin@example.test', 'Backfill Admin', 'ACTIVE')
      returning id
    `;
    const rows = [
      legacyRow({ productGroupKey: '34', skuCode: 'TZX-034-1', linkText: 'Partial source', cargoUnitPriceMilliYuan: 1234 }),
      legacyRow({ productGroupKey: '34', skuCode: 'TZX-034-2', linkText: 'Partial source', cargoUnitPriceMilliYuan: 1234 }),
      legacyRow({ productGroupKey: '35', skuCode: 'TZX-035-1', linkText: 'Complete source' }),
      legacyRow({ productGroupKey: '35', skuCode: 'TZX-035-2', linkText: 'Complete source' }),
      legacyRow({ productGroupKey: '36', skuCode: 'TZX-036-1', linkText: 'Source that must not overwrite', cargoUnitPriceMilliYuan: 1366 }),
    ];
    await sql`alter table feishu_cargo_migration_runs drop constraint feishu_cargo_migration_runs_normalized_rows_json_valid`;
    await sql`alter table feishu_cargo_migration_runs drop constraint feishu_cargo_migration_runs_summary_json_valid`;
    await sql`
      insert into feishu_cargo_migration_runs (
        status, source_spreadsheet_hash, source_sheet_id, source_revision, source_digest,
        summary_json, normalized_rows_json, created_by_admin_user_id
      ) values (
        'IMPORTED', ${"a".repeat(64)}, 'legacy-sheet', 1, ${"b".repeat(64)},
        ${sql.json({ imageCount: 0, productCount: 3, skuCount: 5, sourceSequenceCount: 3, totalQuantity: 5 } as postgres.JSONValue)},
        ${sql.json(rows as postgres.JSONValue)}, ${adminUser.id}::uuid
      )
    `;

    await applyMigrationFile(sql, "0022_backfill_feishu_product_fields.sql");

    const parents = await sql<{
      cargo: number | null; id: string; link: string | null; sequence: string | null;
    }[]>`
      select id::text as id, source_sequence as sequence, link_text as link,
        cargo_unit_price_milli_yuan as cargo
      from products order by name
    `;

    expect(parents).toContainEqual({ id: complete.id, sequence: '35', link: 'Complete source', cargo: null });
    expect(parents).toContainEqual({ id: partial.id, sequence: null, link: null, cargo: null });
    expect(parents).toContainEqual({ id: partialSibling.id, sequence: null, link: null, cargo: null });
    expect(parents).toContainEqual({ id: manual.id, sequence: 'manual-sequence', link: 'manual link', cargo: 999 });
  } finally {
    if (sql) await sql.end({ timeout: 5 });
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${databaseName} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database if exists "${databaseName}"`);
    await admin.end({ timeout: 5 });
  }
});
