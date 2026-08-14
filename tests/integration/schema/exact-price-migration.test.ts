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
  const contents = await readFile(
    path.join(process.cwd(), "drizzle", fileName),
    "utf8",
  );
  for (const statement of splitStatements(contents)) {
    await sql.unsafe(statement);
  }
}

test("0017 backfills exact milli-yuan values in existing Feishu preflight rows", async () => {
  const databaseName = `tzx_exact_price_${randomUUID().replaceAll("-", "")}`;
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
      "0015_feishu_cargo_migration.sql",
      "0016_easy_hiroim.sql",
    ];
    for (const migration of migrations) {
      await applyMigrationFile(sql, migration);
    }

    const adminId = randomUUID();
    await sql`
      insert into admin_users (id, login_identifier, display_name, status)
      values (${adminId}::uuid, 'migration@test.local', 'Migration Test', 'ACTIVE')
    `;
    const legacyRow = {
      color: null,
      combination: null,
      defaultUnitPriceFen: 33,
      imageContentSha256: "1".repeat(64),
      imageTemporaryKey: "temporary/legacy.png",
      inheritedFrom: {},
      linkText: "",
      productGroupKey: "34",
      productName: "Legacy Product",
      productUrl: null,
      saleStatus: "SELLABLE",
      skuCode: "TZX-034-1",
      skuName: "Legacy SKU",
      sourceRowNumber: 2,
      specification: null,
      totalQuantity: 43,
      weightGrams: 68,
    };
    await sql`
      insert into feishu_cargo_migration_runs (
        status,
        source_spreadsheet_hash,
        source_sheet_id,
        source_revision,
        source_digest,
        summary_json,
        normalized_rows_json,
        created_by_admin_user_id
      ) values (
        'PREFLIGHT_READY',
        ${"a".repeat(64)},
        'source-sheet',
        5123,
        ${"b".repeat(64)},
        ${sql.json({ imageCount: 1, productCount: 1, skuCount: 1, totalQuantity: 43 })},
        ${sql.json([legacyRow])},
        ${adminId}::uuid
      )
    `;

    await applyMigrationFile(sql, "0017_slow_iron_fist.sql");

    const [run] = await sql<{ normalizedRows: Array<Record<string, unknown>> }[]>`
      select normalized_rows_json as "normalizedRows"
      from feishu_cargo_migration_runs
    `;
    expect(run.normalizedRows[0]).toMatchObject({
      defaultUnitPriceFen: 33,
      defaultUnitPriceMilliYuan: 330,
      productUrl: null,
    });
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
