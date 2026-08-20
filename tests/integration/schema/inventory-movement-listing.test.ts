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

test("0021 adds auditable movement metadata without inventing legacy manual reasons", async () => {
  const databaseName = `tzx_inventory_listing_${randomUUID().replaceAll("-", "")}`;
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
    ];
    for (const migration of migrations) {
      await applyMigrationFile(sql, migration);
    }

    const [sku] = await sql<{ id: string }[]>`
      with product as (
        insert into products (name) values ('库存流水迁移商品') returning id
      )
      insert into skus (
        default_unit_price_fen,
        default_unit_price_milli_yuan,
        name,
        product_id,
        sku_code
      )
      select 0, 0, '库存流水迁移 SKU', id, 'INV-MIGRATION-001' from product
      returning id
    `;
    const shipmentId = randomUUID();
    const feishuRunId = randomUUID();
    await sql`
      insert into inventory_movements (
        actor_type,
        after_quantity,
        before_quantity,
        delta,
        movement_type,
        reason,
        reference_id,
        reference_type,
        sku_id
      ) values
        ('SYSTEM', 9, 10, -1, 'SHIPMENT', '系统发货旧文案', ${shipmentId}, 'ORDER_SHIPMENT', ${sku.id}),
        ('SYSTEM', 10, 9, 1, 'REVERSAL', '系统撤销旧文案', ${shipmentId}, 'ORDER_SHIPMENT', ${sku.id}),
        ('ADMIN', 12, 10, 2, 'MANUAL_INCREASE', '飞书导入旧文案', ${feishuRunId}, 'FEISHU_CARGO_MIGRATION', ${sku.id}),
        ('ADMIN', 13, 12, 1, 'MANUAL_INCREASE', '仓库同事手写的自由文本', null, null, ${sku.id})
    `;

    await applyMigrationFile(
      sql,
      "0021_inventory_movement_listing_and_stocktakes.sql",
    );

    const enumValues = await sql<{ value: string }[]>`
      select enumlabel as value
      from pg_enum
      inner join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'inventory_movement_reason_code'
      order by enumsortorder
    `;
    expect(enumValues.map(({ value }) => value)).toEqual([
      "RESTOCK_RECEIPT",
      "OFFLINE_FULFILLMENT",
      "CUSTOMER_RETURN",
      "DAMAGED_WRITE_OFF",
      "STOCKTAKE_CORRECTION",
      "OTHER",
      "SYSTEM_SHIPMENT",
      "SHIPMENT_REVERSAL",
      "FEISHU_INITIAL_IMPORT",
    ]);

    const backfilled = await sql<
      { movementType: string; reason: string; reasonCode: string | null }[]
    >`
      select
        movement_type as "movementType",
        reason,
        reason_code as "reasonCode"
      from inventory_movements
      order by case reason
        when '系统撤销旧文案' then 1
        when '系统发货旧文案' then 2
        when '飞书导入旧文案' then 3
        when '仓库同事手写的自由文本' then 4
      end
    `;
    expect(backfilled).toEqual([
      {
        movementType: "REVERSAL",
        reason: "系统撤销旧文案",
        reasonCode: "SHIPMENT_REVERSAL",
      },
      {
        movementType: "SHIPMENT",
        reason: "系统发货旧文案",
        reasonCode: "SYSTEM_SHIPMENT",
      },
      {
        movementType: "MANUAL_INCREASE",
        reason: "飞书导入旧文案",
        reasonCode: "FEISHU_INITIAL_IMPORT",
      },
      {
        movementType: "MANUAL_INCREASE",
        reason: "仓库同事手写的自由文本",
        reasonCode: null,
      },
    ]);

    const stocktakeBatchId = randomUUID();
    await sql`
      insert into inventory_stocktake_batches (id, actor_id, remark)
      values (${stocktakeBatchId}, 'admin-auth-user', '月末盘点')
    `;
    await sql`
      insert into inventory_movements (
        actor_id,
        actor_type,
        after_quantity,
        before_quantity,
        delta,
        movement_type,
        reason,
        reason_code,
        sku_id,
        stocktake_batch_id
      ) values (
        'admin-auth-user',
        'ADMIN',
        14,
        13,
        1,
        'MANUAL_INCREASE',
        '盘点调整',
        'STOCKTAKE_CORRECTION',
        ${sku.id},
        ${stocktakeBatchId}
      )
    `;
    await expect(
      sql`delete from inventory_stocktake_batches where id = ${stocktakeBatchId}`,
    ).rejects.toThrow();
    await expect(
      sql.unsafe(`
        insert into inventory_movements (
          actor_type,
          after_quantity,
          before_quantity,
          delta,
          movement_type,
          reason,
          reason_code,
          sku_id
        ) values (
          'ADMIN', 15, 14, 1, 'MANUAL_INCREASE', '非法原因', 'NOT_A_REASON', '${sku.id}'
        )
      `),
    ).rejects.toThrow();

    const [foreignKey] = await sql<{ deleteRule: string; isNullable: string }[]>`
      select
        information_schema.referential_constraints.delete_rule as "deleteRule",
        information_schema.columns.is_nullable as "isNullable"
      from information_schema.table_constraints
      inner join information_schema.referential_constraints
        on information_schema.referential_constraints.constraint_name = information_schema.table_constraints.constraint_name
      inner join information_schema.key_column_usage
        on information_schema.key_column_usage.constraint_name = information_schema.table_constraints.constraint_name
      inner join information_schema.columns
        on information_schema.columns.table_name = information_schema.table_constraints.table_name
        and information_schema.columns.column_name = information_schema.key_column_usage.column_name
      where information_schema.table_constraints.table_name = 'inventory_movements'
        and information_schema.key_column_usage.column_name = 'stocktake_batch_id'
        and information_schema.table_constraints.constraint_type = 'FOREIGN KEY'
    `;
    expect(foreignKey).toEqual({ deleteRule: "RESTRICT", isNullable: "YES" });

    const indexes = await sql<{ indexDefinition: string; indexName: string }[]>`
      select indexdef as "indexDefinition", indexname as "indexName"
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'inventory_movements'
      order by indexname
    `;
    const indexDefinitionByName = new Map(
      indexes.map(({ indexDefinition, indexName }) => [indexName, indexDefinition]),
    );
    expect(
      indexDefinitionByName.get("inventory_movements_created_id_index"),
    ).toContain("(created_at DESC NULLS LAST, id DESC NULLS LAST)");
    expect(
      indexDefinitionByName.get("inventory_movements_type_created_id_index"),
    ).toContain(
      "(movement_type, created_at DESC NULLS LAST, id DESC NULLS LAST)",
    );
    expect(
      indexDefinitionByName.get("inventory_movements_actor_created_id_index"),
    ).toContain("(actor_id, created_at DESC NULLS LAST, id DESC NULLS LAST)");
    expect(
      indexDefinitionByName.get("inventory_movements_reason_created_id_index"),
    ).toContain("(reason_code, created_at DESC NULLS LAST, id DESC NULLS LAST)");
    expect(
      indexDefinitionByName.get("inventory_movements_sku_created_index"),
    ).toContain("(sku_id, created_at)");
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

test("the migration journal applies inventory listing after the protected migrations", async () => {
  const journal = JSON.parse(
    await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };

  expect(journal.entries.slice(-8).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
    { idx: 21, tag: "0021_inventory_movement_listing_and_stocktakes" },
    { idx: 22, tag: "0022_backfill_feishu_product_fields" },
    { idx: 23, tag: "0023_sku_lifecycle_management" },
    { idx: 24, tag: "0024_sku_cargo_pricing" },
    { idx: 25, tag: "0025_cancelled_order_deduplication" },
    { idx: 26, tag: "0026_jifeng_status_poll_leases" },
    { idx: 27, tag: "0027_expired_order_deduplication" },
    { idx: 28, tag: "0028_package_cancellation_adjustments" },
  ]);
});
