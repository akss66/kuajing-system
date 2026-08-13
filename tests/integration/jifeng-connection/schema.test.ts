import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import { adminUsers } from "@/db/schema";
import type { JifengConnectionStatus } from "@/modules/jifeng-connection/types";

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

type LifecycleRow = {
  authorizedAt?: Date;
  authorizedByAdminUserId?: string;
  fulfillmentEnabledAt?: Date;
  fulfillmentEnabledByAdminUserId?: string;
  status: JifengConnectionStatus;
};

function insertLifecycleRow(row: LifecycleRow) {
  return db.execute(sql`
    insert into jifeng_connections (
      connection_key,
      status,
      authorized_at,
      authorized_by_admin_user_id,
      fulfillment_enabled_at,
      fulfillment_enabled_by_admin_user_id
    ) values (
      'PRIMARY',
      ${row.status},
      ${row.authorizedAt?.toISOString() ?? null}::timestamptz,
      ${row.authorizedByAdminUserId ?? null},
      ${row.fulfillmentEnabledAt?.toISOString() ?? null}::timestamptz,
      ${row.fulfillmentEnabledByAdminUserId ?? null}
    )
  `);
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
        authorized_at,
        authorized_by_admin_user_id,
        fulfillment_enabled_at,
        fulfillment_enabled_by_admin_user_id
      ) values ('PRIMARY', now(), ${authorizer.id}, now(), ${enabler.id})
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

  test.each([
    { authorizedAt: new Date(), authorizedByAdminUserId: undefined },
    { authorizedAt: undefined, authorizedByAdminUserId: "ADMIN" },
  ])(
    "rejects incomplete authorization provenance %#",
    async ({ authorizedAt, authorizedByAdminUserId }) => {
      const admin = await createAdmin("authorization-provenance");

      await expect(
        insertLifecycleRow({
          authorizedAt,
          authorizedByAdminUserId:
            authorizedByAdminUserId === "ADMIN" ? admin.id : undefined,
          status: "DISCONNECTED",
        }),
      ).rejects.toThrow();
    },
  );

  test.each([
    { fulfillmentEnabledAt: new Date(), fulfillmentEnabledByAdminUserId: undefined },
    { fulfillmentEnabledAt: undefined, fulfillmentEnabledByAdminUserId: "ADMIN" },
  ])(
    "rejects incomplete fulfillment enablement provenance %#",
    async ({ fulfillmentEnabledAt, fulfillmentEnabledByAdminUserId }) => {
      const admin = await createAdmin("enablement-provenance");

      await expect(
        insertLifecycleRow({
          fulfillmentEnabledAt,
          fulfillmentEnabledByAdminUserId:
            fulfillmentEnabledByAdminUserId === "ADMIN" ? admin.id : undefined,
          status: "DISCONNECTED",
        }),
      ).rejects.toThrow();
    },
  );

  test.each([
    "AUTHORIZED",
    "RESOURCE_SELECTION_REQUIRED",
    "READY_DISABLED",
    "REFRESH_REQUIRED",
  ] as const)("requires authorization provenance for status %s", async (status) => {
    await expect(insertLifecycleRow({ status })).rejects.toThrow();
  });

  test("requires complete authorization and enablement provenance for ENABLED", async () => {
    const admin = await createAdmin("enabled-state");

    await expect(
      insertLifecycleRow({
        authorizedAt: new Date(),
        authorizedByAdminUserId: admin.id,
        status: "ENABLED",
      }),
    ).rejects.toThrow();
  });

  test.each([
    { status: "DISCONNECTED", withAuthorization: false, withEnablement: false },
    { status: "ERROR", withAuthorization: false, withEnablement: false },
    { status: "READY_DISABLED", withAuthorization: true, withEnablement: true },
    { status: "ENABLED", withAuthorization: true, withEnablement: true },
  ] as const)(
    "accepts a valid $status lifecycle row",
    async ({ status, withAuthorization, withEnablement }) => {
      const admin = await createAdmin(`valid-${status.toLowerCase()}`);
      const now = new Date();

      await expect(
        insertLifecycleRow({
          authorizedAt: withAuthorization ? now : undefined,
          authorizedByAdminUserId: withAuthorization ? admin.id : undefined,
          fulfillmentEnabledAt: withEnablement ? now : undefined,
          fulfillmentEnabledByAdminUserId: withEnablement ? admin.id : undefined,
          status,
        }),
      ).resolves.toBeDefined();
    },
  );
});
