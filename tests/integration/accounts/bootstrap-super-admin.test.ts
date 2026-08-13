import { afterEach, describe, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  authAccounts,
  authUsers,
} from "@/db/schema";
import { bootstrapSuperAdmin } from "@/db/bootstrap-super-admin";

const input = {
  displayName: "Production Super Admin",
  email: "admin@qq.com",
  password: "Production-Bootstrap-Password-2026!",
};

describe("production super admin bootstrap", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        auth_sessions,
        auth_accounts,
        auth_verifications,
        auth_users,
        customer_users,
        admin_users
      restart identity cascade
    `));
  });

  test("creates only the protected super admin and its credential mirror", async () => {
    const result = await bootstrapSuperAdmin(input);

    expect(result).toMatchObject({ created: true, email: "admin@qq.com" });
    expect(await db.select().from(authUsers)).toEqual([
      expect.objectContaining({
        customerId: null,
        email: "admin@qq.com",
        id: "00000000-0000-4000-8000-00000000a001",
        role: "super_admin",
      }),
    ]);
    expect(await db.select().from(authAccounts)).toEqual([
      expect.objectContaining({
        accountId: "00000000-0000-4000-8000-00000000a001",
        providerId: "credential",
        userId: "00000000-0000-4000-8000-00000000a001",
      }),
    ]);
    expect(await db.select().from(adminUsers)).toEqual([
      expect.objectContaining({
        displayName: "Production Super Admin",
        loginIdentifier: "admin@qq.com",
        status: "ACTIVE",
      }),
    ]);
    expect(await db.select().from(auditLogs)).toEqual([
      expect.objectContaining({
        action: "SUPER_ADMIN_BOOTSTRAPPED",
        actorType: "SYSTEM",
        entityId: "00000000-0000-4000-8000-00000000a001",
      }),
    ]);
  });

  test("is idempotent for the same protected account without changing its password", async () => {
    await bootstrapSuperAdmin(input);
    const [before] = await db
      .select({ password: authAccounts.password })
      .from(authAccounts);

    const result = await bootstrapSuperAdmin({
      ...input,
      password: "A-Different-Password-That-Must-Not-Replace-It!",
    });
    const [after] = await db
      .select({ password: authAccounts.password })
      .from(authAccounts);

    expect(result).toMatchObject({ created: false, email: "admin@qq.com" });
    expect(after.password).toBe(before.password);
    expect(await db.select().from(authUsers)).toHaveLength(1);
    expect(await db.select().from(auditLogs)).toHaveLength(1);
  });

  test("refuses to bootstrap into a database that already has another account", async () => {
    await db.insert(authUsers).values({
      customerId: null,
      email: "existing-admin@example.com",
      id: crypto.randomUUID(),
      name: "Existing Admin",
      role: "admin",
    });

    await expect(bootstrapSuperAdmin(input)).rejects.toThrow(
      "Bootstrap requires an empty account database",
    );
    expect(
      await db.select().from(authUsers).where(eq(authUsers.role, "super_admin")),
    ).toHaveLength(0);
  });
});
