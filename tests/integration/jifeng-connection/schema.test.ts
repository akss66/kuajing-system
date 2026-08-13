import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import { adminUsers } from "@/db/schema";

async function createAdmin(label: string) {
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: `Jifeng ${label}`,
      loginIdentifier: `jifeng-${label}-${crypto.randomUUID()}@example.test`,
    })
    .returning({ id: adminUsers.id });
  return admin;
}

describe("Jifeng connection schema", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      do $$
      begin
        if to_regclass('public.jifeng_authorization_attempts') is not null then
          truncate table jifeng_authorization_attempts, jifeng_connections, admin_users
            restart identity cascade;
        end if;
      end $$
    `));
  });

  test("allows only one fixed PRIMARY connection", async () => {
    await db.execute(sql`
      insert into jifeng_connections (connection_key)
      values ('PRIMARY')
    `);

    await expect(
      db.execute(sql`
        insert into jifeng_connections (connection_key)
        values ('PRIMARY')
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into jifeng_connections (connection_key)
        values ('SECONDARY')
      `),
    ).rejects.toThrow();
  });

  test("constrains connection states to the lifecycle status set", async () => {
    const labels = await db.execute<{ enumlabel: string }>(sql`
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'jifeng_connection_status'
      order by enumsortorder
    `);

    expect(labels.map(({ enumlabel }) => enumlabel)).toEqual([
      "DISCONNECTED",
      "AUTHORIZED",
      "RESOURCE_SELECTION_REQUIRED",
      "READY_DISABLED",
      "ENABLED",
      "REFRESH_REQUIRED",
      "ERROR",
    ]);
  });

  test("links authorization and fulfillment enablement to administrators", async () => {
    const [authorizer, enabler] = await Promise.all([
      createAdmin("authorizer"),
      createAdmin("enabler"),
    ]);

    await db.execute(sql`
      insert into jifeng_connections (
        connection_key,
        authorized_by_admin_user_id,
        fulfillment_enabled_by_admin_user_id
      ) values ('PRIMARY', ${authorizer.id}, ${enabler.id})
    `);

    await expect(
      db.delete(adminUsers).where(sql`${adminUsers.id} = ${authorizer.id}`),
    ).rejects.toThrow();
    await expect(
      db.delete(adminUsers).where(sql`${adminUsers.id} = ${enabler.id}`),
    ).rejects.toThrow();
  });

  test("authorization attempts persist only sanitized operational fields", async () => {
    const columns = await db.execute<{ columnName: string }>(sql`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'jifeng_authorization_attempts'
      order by column_name
    `);

    expect(columns.map(({ columnName }) => columnName)).toEqual([
      "admin_user_id",
      "attempted_at",
      "error_category",
      "id",
      "result",
    ]);
  });
});
