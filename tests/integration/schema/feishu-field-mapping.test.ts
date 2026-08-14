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

test("0020 persists independent Feishu fields and rejects a negative cargo price", async () => {
  const databaseName = `tzx_feishu_field_mapping_${randomUUID().replaceAll("-", "")}`;
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
    ];
    for (const migration of migrations) {
      await applyMigrationFile(sql, migration);
    }
    await applyMigrationFile(sql, "0019_jifeng_bigint_logistics_id.sql");
    await applyMigrationFile(sql, "0020_feishu_field_mapping.sql");

    const [product] = await sql<{
      cargoUnitPriceMilliYuan: number;
      linkText: string;
      sourceSequence: string;
    }[]>`
      insert into products (
        cargo_unit_price_milli_yuan,
        link_text,
        name,
        source_sequence
      ) values (1366, '查看飞书商品', '字段映射商品', '34')
      returning
        cargo_unit_price_milli_yuan as "cargoUnitPriceMilliYuan",
        link_text as "linkText",
        source_sequence as "sourceSequence"
    `;

    expect(product).toMatchObject({
      cargoUnitPriceMilliYuan: 1366,
      linkText: "查看飞书商品",
      sourceSequence: "34",
    });
    await expect(
      sql`
        insert into products (cargo_unit_price_milli_yuan, name, source_sequence)
        values (-1, '非法货品价格', 'negative-price')
      `,
    ).rejects.toThrow();
    await expect(
      sql`
        insert into products (name, source_sequence)
        values ('重复源序号商品', '34')
      `,
    ).rejects.toThrow();
    await sql`
      insert into products (name)
      values ('手动商品一'), ('手动商品二')
    `;
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
