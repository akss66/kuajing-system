import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  authAccounts,
  authSessions,
  authUsers,
  customers,
  customerUsers,
} from "@/db/schema";
import type { DbTransaction } from "@/db/client";
import type { AdminPrincipal, SuperAdminPrincipal } from "@/modules/identity/principal";
import { maskEmail } from "@/shared/privacy";

import {
  listManagedAccounts as listManagedAccountsQuery,
  type ManagedAccountSummary,
} from "./queries";

type AccountActor = AdminPrincipal | SuperAdminPrincipal;
type ManagedAccountStatus = "ACTIVE" | "DISABLED";

export class AccountGovernanceError extends Error {
  constructor(
    public readonly code:
      | "ACCOUNT_NOT_FOUND"
      | "CUSTOMER_ACCOUNT_REQUIRED"
      | "FORBIDDEN_SUPER_ADMIN"
      | "INVALID_PASSWORD"
      | "INVALID_REASON"
      | "PROHIBITED_SUPER_ADMIN_CREATION"
      | "SUPER_ADMIN_IMMUTABLE",
    message: string,
  ) {
    super(message);
    this.name = "AccountGovernanceError";
  }
}

function assertSuperAdmin(actor: AccountActor) {
  if (actor.kind !== "SUPER_ADMIN") {
    throw new AccountGovernanceError(
      "FORBIDDEN_SUPER_ADMIN",
      "Only the super admin can manage accounts",
    );
  }
}

function assertReason(reason: string) {
  const value = reason.trim();
  if (!value) {
    throw new AccountGovernanceError("INVALID_REASON", "A reason is required");
  }
  return value;
}

function assertPassword(password: string) {
  if (password.length < 12) {
    throw new AccountGovernanceError(
      "INVALID_PASSWORD",
      "Password must be at least 12 characters",
    );
  }
}

function accountStatusFromUser(user: {
  banned: boolean;
}): ManagedAccountStatus {
  return user.banned ? "DISABLED" : "ACTIVE";
}

async function getManagedUser(tx: DbTransaction, userId: string) {
  const [user] = await tx
    .select()
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  if (!user) {
    throw new AccountGovernanceError("ACCOUNT_NOT_FOUND", "Account not found");
  }
  return user;
}

async function writeAudit(
  tx: DbTransaction,
  input: {
    action: string;
    actorUserId: string;
    afterJson: Record<string, unknown>;
    beforeJson: Record<string, unknown>;
    entityId: string;
    reason: string;
  },
) {
  await tx.insert(auditLogs).values({
    action: input.action,
    actorId: input.actorUserId,
    actorType: "ADMIN",
    afterJson: input.afterJson,
    beforeJson: input.beforeJson,
    entityId: input.entityId,
    entityType: "ACCOUNT",
    reason: input.reason,
  });
}

async function syncAdminMirror(
  tx: DbTransaction,
  input: {
    currentEmail?: string;
    displayName: string;
    email: string;
    status: ManagedAccountStatus;
  },
) {
  const [existing] = input.currentEmail
    ? await tx
        .select({ id: adminUsers.id })
        .from(adminUsers)
        .where(eq(adminUsers.loginIdentifier, input.currentEmail))
        .limit(1)
    : [];

  if (existing) {
    await tx
      .update(adminUsers)
      .set({
        displayName: input.displayName,
        loginIdentifier: input.email,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(adminUsers.id, existing.id));
    return;
  }

  await tx.insert(adminUsers).values({
    displayName: input.displayName,
    loginIdentifier: input.email,
    status: input.status,
  });
}

async function syncCustomerMirror(
  tx: DbTransaction,
  input: {
    customerId: string;
    displayName: string;
    email: string;
    status: ManagedAccountStatus;
  },
) {
  const [existing] = await tx
    .select({ id: customerUsers.id })
    .from(customerUsers)
    .where(eq(customerUsers.customerId, input.customerId))
    .limit(1);

  if (existing) {
    await tx
      .update(customerUsers)
      .set({
        displayName: input.displayName,
        loginIdentifier: input.email,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(customerUsers.id, existing.id));
    return;
  }

  await tx.insert(customerUsers).values({
    customerId: input.customerId,
    displayName: input.displayName,
    loginIdentifier: input.email,
    status: input.status,
  });
}

async function syncRoleMirror(
  tx: DbTransaction,
  user: typeof authUsers.$inferSelect,
  next: {
    displayName: string;
    email: string;
    status: ManagedAccountStatus;
  },
) {
  if (user.role === "admin" || user.role === "super_admin") {
    await syncAdminMirror(tx, {
      currentEmail: user.email,
      displayName: next.displayName,
      email: next.email,
      status: next.status,
    });
    return;
  }

  if (user.customerId) {
    await syncCustomerMirror(tx, {
      customerId: user.customerId,
      displayName: next.displayName,
      email: next.email,
      status: next.status,
    });
  }
}

export async function createAdminAccount(input: {
  actor: AccountActor;
  displayName: string;
  email: string;
  password: string;
  reason: string;
  role?: string;
}): Promise<ManagedAccountSummary> {
  assertSuperAdmin(input.actor);
  assertPassword(input.password);
  if (input.role && input.role !== "admin") {
    throw new AccountGovernanceError(
      "PROHIBITED_SUPER_ADMIN_CREATION",
      "Account governance cannot create a super admin",
    );
  }
  const reason = assertReason(input.reason);
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const passwordHash = await hashPassword(input.password);
  const userId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(authUsers).values({
      banned: false,
      email,
      id: userId,
      name: displayName,
      role: "admin",
    });
    await tx.insert(authAccounts).values({
      accountId: userId,
      id: crypto.randomUUID(),
      password: passwordHash,
      providerId: "credential",
      userId,
    });
    await syncAdminMirror(tx, {
      displayName,
      email,
      status: "ACTIVE",
    });
    await writeAudit(tx, {
      action: "ACCOUNT_CREATED",
      actorUserId: input.actor.userId,
      afterJson: {
        displayName,
        email: maskEmail(email),
        role: "admin",
        status: "ACTIVE",
      },
      beforeJson: {},
      entityId: userId,
      reason,
    });
  });

  const [created] = (await listManagedAccountsQuery()).filter(
    (account) => account.userId === userId,
  );
  return created;
}

export async function updateManagedAccount(input: {
  actor: AccountActor;
  displayName: string;
  email: string;
  reason: string;
  role?: string;
  userId: string;
}) {
  assertSuperAdmin(input.actor);
  const reason = assertReason(input.reason);
  const nextEmail = input.email.trim().toLowerCase();
  const nextName = input.displayName.trim();

  await db.transaction(async (tx) => {
    const user = await getManagedUser(tx, input.userId);
    if (user.role === "super_admin") {
      throw new AccountGovernanceError(
        "SUPER_ADMIN_IMMUTABLE",
        "The super admin cannot be changed",
      );
    }
    if (input.role && input.role !== user.role) {
      throw new AccountGovernanceError(
        "PROHIBITED_SUPER_ADMIN_CREATION",
        "Account governance cannot change roles to super admin",
      );
    }
    await tx
      .update(authUsers)
      .set({
        email: nextEmail,
        name: nextName,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, input.userId));
    await syncRoleMirror(tx, user, {
      displayName: nextName,
      email: nextEmail,
      status: accountStatusFromUser(user),
    });
    await writeAudit(tx, {
      action: "ACCOUNT_UPDATED",
      actorUserId: input.actor.userId,
      afterJson: {
        displayName: nextName,
        email: maskEmail(nextEmail),
      },
      beforeJson: {
        displayName: user.name,
        email: maskEmail(user.email),
      },
      entityId: user.id,
      reason,
    });
  });
}

export async function resetManagedAccountPassword(input: {
  actor: AccountActor;
  newPassword: string;
  reason: string;
  userId: string;
}) {
  assertSuperAdmin(input.actor);
  assertPassword(input.newPassword);
  const reason = assertReason(input.reason);
  const passwordHash = await hashPassword(input.newPassword);

  await db.transaction(async (tx) => {
    const user = await getManagedUser(tx, input.userId);
    const [account] = await tx
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, input.userId),
          eq(authAccounts.providerId, "credential"),
        ),
      )
      .limit(1);

    if (account) {
      await tx
        .update(authAccounts)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(eq(authAccounts.id, account.id));
    } else {
      await tx.insert(authAccounts).values({
        accountId: input.userId,
        id: crypto.randomUUID(),
        password: passwordHash,
        providerId: "credential",
        userId: input.userId,
      });
    }

    await writeAudit(tx, {
      action: "ACCOUNT_PASSWORD_RESET",
      actorUserId: input.actor.userId,
      afterJson: { passwordReset: true },
      beforeJson: { email: maskEmail(user.email) },
      entityId: input.userId,
      reason,
    });
  });
}

export async function setManagedAccountStatus(input: {
  actor: AccountActor;
  reason: string;
  status: ManagedAccountStatus;
  userId: string;
}) {
  assertSuperAdmin(input.actor);
  const reason = assertReason(input.reason);

  await db.transaction(async (tx) => {
    const user = await getManagedUser(tx, input.userId);
    if (user.role === "super_admin") {
      throw new AccountGovernanceError(
        "SUPER_ADMIN_IMMUTABLE",
        "The super admin cannot be disabled",
      );
    }

    const banned = input.status === "DISABLED";
    await tx
      .update(authUsers)
      .set({
        banExpires: null,
        banReason: banned ? reason : null,
        banned,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, user.id));

    if (banned) {
      await tx.delete(authSessions).where(eq(authSessions.userId, user.id));
    }

    await syncRoleMirror(tx, user, {
      displayName: user.name,
      email: user.email,
      status: input.status,
    });

    await writeAudit(tx, {
      action: "ACCOUNT_STATUS_CHANGED",
      actorUserId: input.actor.userId,
      afterJson: { status: input.status },
      beforeJson: { status: accountStatusFromUser(user) },
      entityId: user.id,
      reason,
    });
  });
}

export async function setCustomerAiSkuMatchAccess(input: {
  actor: AccountActor;
  enabled: boolean;
  reason: string;
  userId: string;
}) {
  assertSuperAdmin(input.actor);
  const reason = assertReason(input.reason);

  await db.transaction(async (tx) => {
    const user = await getManagedUser(tx, input.userId);
    if (user.role !== "user" || !user.customerId) {
      throw new AccountGovernanceError(
        "CUSTOMER_ACCOUNT_REQUIRED",
        "AI SKU matching access can only target a customer account",
      );
    }
    const [customer] = await tx
      .select({
        aiSkuMatchEnabled: customers.aiSkuMatchEnabled,
        id: customers.id,
      })
      .from(customers)
      .where(eq(customers.id, user.customerId))
      .for("update")
      .limit(1);
    if (!customer) {
      throw new AccountGovernanceError(
        "CUSTOMER_ACCOUNT_REQUIRED",
        "Customer record not found",
      );
    }

    await tx
      .update(customers)
      .set({ aiSkuMatchEnabled: input.enabled, updatedAt: new Date() })
      .where(eq(customers.id, customer.id));
    await tx.insert(auditLogs).values({
      action: "CUSTOMER_AI_SKU_MATCH_ACCESS_CHANGED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: { aiSkuMatchEnabled: input.enabled },
      beforeJson: { aiSkuMatchEnabled: customer.aiSkuMatchEnabled },
      entityId: customer.id,
      entityType: "CUSTOMER",
      reason,
    });
  });
}

export { listManagedAccountsQuery as listManagedAccounts };
