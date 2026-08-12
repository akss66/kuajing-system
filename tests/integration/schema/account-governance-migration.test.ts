import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";
import { afterEach, expect, test } from "vitest";

const baseDatabaseUrl = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);

function splitStatements(sqlText: string) {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigrationFile(sql: postgres.Sql, relativePath: string) {
  const absolutePath = path.join(process.cwd(), relativePath);
  const contents = await readFile(absolutePath, "utf8");
  for (const statement of splitStatements(contents)) {
    await sql.unsafe(statement);
  }
}

async function createDisposableDatabase() {
  const databaseName = `tzx_account_governance_${randomUUID().replace(/-/g, "")}`;
  const adminUrl = new URL(baseDatabaseUrl.toString());
  adminUrl.pathname = "/postgres";

  const admin = postgres(adminUrl.toString(), { idle_timeout: 1, max: 1 });
  await admin.unsafe(`create database "${databaseName}"`);

  const disposableUrl = new URL(baseDatabaseUrl.toString());
  disposableUrl.pathname = `/${databaseName}`;
  const sql = postgres(disposableUrl.toString(), { idle_timeout: 1, max: 1 });

  await sql`create extension if not exists pgcrypto`;
  await applyMigrationFile(sql, "drizzle/0000_aromatic_shocker.sql");
  await applyMigrationFile(sql, "drizzle/0001_thin_yellow_claw.sql");

  return { admin, databaseName, sql };
}

async function destroyDisposableDatabase(input: {
  admin: postgres.Sql;
  databaseName: string;
  sql: postgres.Sql;
}) {
  await input.sql.end({ timeout: 5 });
  await input.admin`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${input.databaseName}
      and pid <> pg_backend_pid()
  `;
  await input.admin.unsafe(`drop database if exists "${input.databaseName}"`);
  await input.admin.end({ timeout: 5 });
}

const disposables: Array<Awaited<ReturnType<typeof createDisposableDatabase>>> = [];

afterEach(async () => {
  while (disposables.length > 0) {
    const disposable = disposables.pop();
    if (disposable) {
      await destroyDisposableDatabase(disposable);
    }
  }
});

async function selectAuthUserRoles(sql: postgres.Sql) {
  return sql<{ email: string; id: string; role: string }[]>`
    select id, email, role
    from auth_users
    order by email asc
  `;
}

test("migration upgrades the single bootstrap row when both markers hit the same row", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  await disposable.sql`
    insert into auth_users (id, name, email, role)
    values
      ('00000000-0000-4000-8000-00000000a001', 'Bootstrap Admin', 'admin@tongzhouxing.local', 'admin'),
      ('legacy-admin-2', 'Legacy Admin', 'ops-admin@test.local', 'admin')
  `;

  await applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql");

  const rows = await selectAuthUserRoles(disposable.sql);

  expect(rows).toEqual([
    {
      email: "admin@tongzhouxing.local",
      id: "00000000-0000-4000-8000-00000000a001",
      role: "super_admin",
    },
    { email: "ops-admin@test.local", id: "legacy-admin-2", role: "admin" },
  ]);
});

test("migration upgrades the bootstrap row when only the fixed id marker exists", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  await disposable.sql`
    insert into auth_users (id, name, email, role)
    values
      ('00000000-0000-4000-8000-00000000a001', 'Bootstrap Admin', 'renamed-admin@test.local', 'admin'),
      ('legacy-admin-2', 'Legacy Admin', 'ops-admin@test.local', 'admin')
  `;

  await applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql");

  const rows = await selectAuthUserRoles(disposable.sql);

  expect(rows).toEqual([
    { email: "ops-admin@test.local", id: "legacy-admin-2", role: "admin" },
    {
      email: "renamed-admin@test.local",
      id: "00000000-0000-4000-8000-00000000a001",
      role: "super_admin",
    },
  ]);
});

test("migration upgrades the bootstrap row when only the fixed email marker exists", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  await disposable.sql`
    insert into auth_users (id, name, email, role)
    values
      ('legacy-bootstrap', 'Bootstrap Admin', 'admin@tongzhouxing.local', 'admin'),
      ('legacy-admin-2', 'Legacy Admin', 'ops-admin@test.local', 'admin')
  `;

  await applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql");

  const rows = await selectAuthUserRoles(disposable.sql);

  expect(rows).toEqual([
    { email: "admin@tongzhouxing.local", id: "legacy-bootstrap", role: "super_admin" },
    { email: "ops-admin@test.local", id: "legacy-admin-2", role: "admin" },
  ]);
});

test("migration fails fast when bootstrap id and email markers point at different rows", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  await disposable.sql`
    insert into auth_users (id, name, email, role)
    values
      ('00000000-0000-4000-8000-00000000a001', 'Marker By Id', 'renamed-admin@test.local', 'admin'),
      ('legacy-bootstrap', 'Marker By Email', 'admin@tongzhouxing.local', 'admin')
  `;

  await expect(
    applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql"),
  ).rejects.toThrow(/bootstrap super admin markers resolve to multiple rows/i);
});

test("migration fails fast when customer auth rows duplicate a customer_id", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  const [customer] = await disposable.sql<{ id: string }[]>`
    insert into customers (code, name)
    values ('DUP-CUSTOMER', 'Duplicate Customer')
    returning id
  `;

  await disposable.sql`
    insert into auth_users (id, name, email, role, customer_id)
    values
      ('dup-user-1', 'Duplicate User 1', 'dup-1@test.local', 'user', ${customer.id}::uuid),
      ('dup-user-2', 'Duplicate User 2', 'dup-2@test.local', 'user', ${customer.id}::uuid)
  `;

  await expect(
    applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql"),
  ).rejects.toThrow(/duplicate auth_users\.customer_id/i);
});

test("migration rejects unsupported legacy auth roles with a diagnostic", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  await disposable.sql`
    insert into auth_users (id, name, email, role)
    values ('invalid-role-user', 'Invalid Role', 'invalid-role@test.local', 'manager')
  `;

  await expect(
    applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql"),
  ).rejects.toThrow(/unsupported auth_users\.role/i);
});

test("migration rejects user rows that do not point at a customer", async () => {
  const disposable = await createDisposableDatabase();
  disposables.push(disposable);

  await disposable.sql`
    insert into auth_users (id, name, email, role)
    values ('orphan-user', 'Orphan User', 'orphan-user@test.local', 'user')
  `;

  await expect(
    applyMigrationFile(disposable.sql, "drizzle/0014_account_governance.sql"),
  ).rejects.toThrow(/user role rows without customer_id/i);
});
