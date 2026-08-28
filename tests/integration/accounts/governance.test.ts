import { afterEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { auth } from "@/modules/identity/auth";
import {
  adminUsers,
  auditLogs,
  authSessions,
  authUsers,
  customers,
  customerUsers,
} from "@/db/schema";
import {
  createAdminAccount,
  listManagedAccounts,
  setManagedAccountStatus,
  setCustomerAiSkuMatchAccess,
  updateManagedAccount,
} from "@/modules/accounts/service";
import { seed } from "@/db/seed";

async function expectConstraintFailure(
  operation: Promise<unknown>,
  constraintName: string,
) {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({
      cause: expect.objectContaining({
        constraint_name: constraintName,
      }),
    });
    return;
  }

  throw new Error(`Expected constraint failure: ${constraintName}`);
}

describe("account governance", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        ai_sku_match_suggestions,
        ai_sku_match_runs,
        system_notifications,
        integration_attempts,
        integration_outbox,
        replacement_requests,
        shipment_fulfillments,
        audit_logs,
        payment_claims,
        wallet_transactions,
        wallet_accounts,
        order_lines,
        order_shipments,
        fulfillment_orders,
        order_import_rows,
        order_import_batches,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        sku_aliases,
        customer_sku_prices,
        auth_sessions,
        auth_accounts,
        auth_verifications,
        auth_users,
        customer_users,
        admin_users,
        stores,
        skus,
        products,
        customers
      restart identity cascade
    `));
  });

  test("bootstrap seed creates one super admin account", async () => {
    await seed();

    const superAdmins = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.role, "super_admin"));

    expect(superAdmins).toHaveLength(1);
    expect(superAdmins[0].email).toBe("admin@tongzhouxing.local");
  });

  test("bootstrap seed also creates the protected admin and customer mirror profiles", async () => {
    await seed();

    const [adminProfile] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.loginIdentifier, "admin@tongzhouxing.local"));
    const [customerProfile] = await db
      .select()
      .from(customerUsers)
      .where(eq(customerUsers.loginIdentifier, "customer@tongzhouxing.local"));

    expect(adminProfile).toMatchObject({
      displayName: "本地演示管理员",
      status: "ACTIVE",
    });
    expect(customerProfile).toMatchObject({
      displayName: "渝太华演示客户",
      status: "ACTIVE",
    });
  });

  test("allows at most one auth user per customer", async () => {
    const [customer] = await db
      .insert(customers)
      .values({
        code: `ACCOUNT-${crypto.randomUUID().slice(0, 8)}`,
        name: "Governed customer",
      })
      .returning({ id: customers.id });

    await expectConstraintFailure(
      db.insert(authUsers).values([
        {
          customerId: customer.id,
          email: `customer-a-${crypto.randomUUID()}@tongzhouxing.local`,
          id: crypto.randomUUID(),
          name: "Customer User A",
          role: "user",
        },
        {
          customerId: customer.id,
          email: `customer-b-${crypto.randomUUID()}@tongzhouxing.local`,
          id: crypto.randomUUID(),
          name: "Customer User B",
          role: "user",
        },
      ]),
      "auth_users_customer_unique",
    );
  });

  test("only super admins can create admin accounts", async () => {
    await expect(
      createAdminAccount({
        actor: { kind: "ADMIN", userId: crypto.randomUUID() },
        displayName: "Operations Admin",
        email: `ops-${crypto.randomUUID()}@tongzhouxing.local`,
        password: "valid-admin-password-2026",
        reason: "Provision operations admin",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
  });

  test("account services reject creating another super admin", async () => {
    await expect(
      createAdminAccount({
        actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
        displayName: "Prohibited Super Admin",
        email: `super-${crypto.randomUUID()}@tongzhouxing.local`,
        password: "valid-admin-password-2026",
        reason: "Should be rejected",
        role: "super_admin",
      }),
    ).rejects.toMatchObject({ code: "PROHIBITED_SUPER_ADMIN_CREATION" });
  });

  test("disabling an admin account revokes all active sessions", async () => {
    const created = await createAdminAccount({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      displayName: "Warehouse Admin",
      email: `warehouse-${crypto.randomUUID()}@tongzhouxing.local`,
      password: "valid-admin-password-2026",
      reason: "Provision warehouse admin",
    });
    const signInResponse = await auth.handler(
      new Request("http://127.0.0.1:3000/api/auth/sign-in/email", {
        body: JSON.stringify({
          email: created.email,
          password: "valid-admin-password-2026",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(signInResponse.status).toBe(200);
    expect(await db.select().from(authSessions)).toHaveLength(1);

    await setManagedAccountStatus({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      reason: "Left the company",
      status: "DISABLED",
      userId: created.userId,
    });

    expect(await db.select().from(authSessions)).toEqual([]);
  });

  test("existing super admin cannot be disabled", async () => {
    await seed();
    const [superAdmin] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.role, "super_admin"));

    await expect(
      setManagedAccountStatus({
        actor: { kind: "SUPER_ADMIN", userId: superAdmin.id },
        reason: "Should fail",
        status: "DISABLED",
        userId: superAdmin.id,
      }),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_IMMUTABLE" });
  });

  test("existing super admin cannot be demoted or promoted through update", async () => {
    await seed();
    const [superAdmin] = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.role, "super_admin"));

    await expect(
      updateManagedAccount({
        actor: { kind: "SUPER_ADMIN", userId: superAdmin.id },
        displayName: "Still Super Admin",
        email: superAdmin.email,
        reason: "Should fail",
        role: "admin",
        userId: superAdmin.id,
      }),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_IMMUTABLE" });
  });

  test("ordinary admins cannot promote another account to super admin", async () => {
    const created = await createAdminAccount({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      displayName: "Warehouse Admin",
      email: `warehouse-${crypto.randomUUID()}@tongzhouxing.local`,
      password: "valid-admin-password-2026",
      reason: "Provision warehouse admin",
    });

    await expect(
      updateManagedAccount({
        actor: { kind: "ADMIN", userId: created.userId },
        displayName: created.displayName,
        email: created.email,
        reason: "Should fail",
        role: "super_admin",
        userId: created.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
  });

  test("ordinary admins cannot update or disable managed accounts", async () => {
    const created = await createAdminAccount({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      displayName: "Warehouse Admin",
      email: `warehouse-${crypto.randomUUID()}@tongzhouxing.local`,
      password: "valid-admin-password-2026",
      reason: "Provision warehouse admin",
    });

    await expect(
      updateManagedAccount({
        actor: { kind: "ADMIN", userId: created.userId },
        displayName: "Updated by ordinary admin",
        email: created.email,
        reason: "Should fail",
        userId: created.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });

    await expect(
      setManagedAccountStatus({
        actor: { kind: "ADMIN", userId: created.userId },
        reason: "Should fail",
        status: "DISABLED",
        userId: created.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
  });

  test("managed account listing returns customer ownership and store counts", async () => {
    const [customer] = await db
      .insert(customers)
      .values({
        code: `LIST-${crypto.randomUUID().slice(0, 8)}`,
        name: "Listed customer",
      })
      .returning({ id: customers.id });
    await db.insert(authUsers).values({
      customerId: customer.id,
      email: `listed-${crypto.randomUUID()}@tongzhouxing.local`,
      id: crypto.randomUUID(),
      name: "Listed Customer User",
      role: "user",
    });

    const accounts = await listManagedAccounts();
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aiSkuMatchEnabled: false,
          customerId: customer.id,
          kind: "CUSTOMER",
          storeCount: 0,
        }),
      ]),
    );
  });

  test("super admin can govern per-customer AI matching with an audited reason", async () => {
    const [customer] = await db
      .insert(customers)
      .values({
        code: `AI-ACCESS-${crypto.randomUUID().slice(0, 8)}`,
        name: "AI access customer",
      })
      .returning({ id: customers.id });
    const userId = crypto.randomUUID();
    await db.insert(authUsers).values({
      customerId: customer.id,
      email: `ai-access-${crypto.randomUUID()}@tongzhouxing.local`,
      id: userId,
      name: "AI Access Customer",
      role: "user",
    });

    await setCustomerAiSkuMatchAccess({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      enabled: true,
      reason: "Pilot cohort approval",
      userId,
    });

    await expect(
      db
        .select({ enabled: customers.aiSkuMatchEnabled })
        .from(customers)
        .where(eq(customers.id, customer.id)),
    ).resolves.toEqual([{ enabled: true }]);
    await expect(
      db
        .select({
          action: auditLogs.action,
          entityId: auditLogs.entityId,
          reason: auditLogs.reason,
        })
        .from(auditLogs)
        .where(eq(auditLogs.entityId, customer.id)),
    ).resolves.toEqual([
      {
        action: "CUSTOMER_AI_SKU_MATCH_ACCESS_CHANGED",
        entityId: customer.id,
        reason: "Pilot cohort approval",
      },
    ]);
  });

  test("ordinary admins and non-customer targets cannot change AI access", async () => {
    const created = await createAdminAccount({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      displayName: "Operations Admin",
      email: `ai-admin-${crypto.randomUUID()}@tongzhouxing.local`,
      password: "valid-admin-password-2026",
      reason: "Provision admin",
    });

    await expect(
      setCustomerAiSkuMatchAccess({
        actor: { kind: "ADMIN", userId: created.userId },
        enabled: true,
        reason: "Should fail",
        userId: created.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
    await expect(
      setCustomerAiSkuMatchAccess({
        actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
        enabled: true,
        reason: "Should fail",
        userId: created.userId,
      }),
    ).rejects.toMatchObject({ code: "CUSTOMER_ACCOUNT_REQUIRED" });
  });
});
