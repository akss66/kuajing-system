import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  customers,
  customerUsers,
  stores,
} from "@/db/schema";

describe("identity, customer and audit schema", () => {
  afterEach(async () => {
    await db.delete(auditLogs);
    await db.delete(customerUsers);
    await db.delete(stores);
    await db.delete(adminUsers);
    await db.delete(customers);
  });

  test("a store cannot reference a missing customer", async () => {
    await expect(
      db.insert(stores).values({
        id: crypto.randomUUID(),
        customerId: crypto.randomUUID(),
        name: "不存在客户的店铺",
        status: "ACTIVE",
      }),
    ).rejects.toThrow();
  });

  test("an audit row cannot omit required event context", async () => {
    await expect(
      db.execute(sql`
        insert into audit_logs (id, actor_type, created_at)
        values (${crypto.randomUUID()}, 'SYSTEM', now())
      `),
    ).rejects.toThrow();
  });

  test("admin login identifiers are unique", async () => {
    const loginIdentifier = "admin@tongzhouxing.local";
    await db.insert(adminUsers).values({
      displayName: "超级管理员",
      loginIdentifier,
    });

    await expect(
      db.insert(adminUsers).values({
        displayName: "重复账号",
        loginIdentifier,
      }),
    ).rejects.toThrow();
  });
});
