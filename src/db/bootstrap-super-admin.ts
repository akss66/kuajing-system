import { pathToFileURL } from "node:url";

import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "./client";
import {
  adminUsers,
  auditLogs,
  authAccounts,
  authUsers,
} from "./schema";

const PROTECTED_SUPER_ADMIN_ID = "00000000-0000-4000-8000-00000000a001";
const BOOTSTRAP_LOCK_ID = 7_028_260_814;

const bootstrapInputSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(256),
});

export async function bootstrapSuperAdmin(rawInput: {
  displayName: string;
  email: string;
  password: string;
}) {
  const input = bootstrapInputSchema.parse(rawInput);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_ID})`);

    const existingUsers = await tx
      .select({ email: authUsers.email, id: authUsers.id, role: authUsers.role })
      .from(authUsers)
      .limit(2);

    if (existingUsers.length > 0) {
      const [existing] = existingUsers;
      const isProtectedAccount =
        existingUsers.length === 1 &&
        existing.id === PROTECTED_SUPER_ADMIN_ID &&
        existing.email.toLowerCase() === input.email &&
        existing.role === "super_admin";

      if (isProtectedAccount) {
        return { created: false as const, email: existing.email };
      }

      throw new Error("Bootstrap requires an empty account database");
    }

    const passwordHash = await hashPassword(input.password);

    await tx.insert(authUsers).values({
      banned: false,
      email: input.email,
      id: PROTECTED_SUPER_ADMIN_ID,
      name: input.displayName,
      role: "super_admin",
    });
    await tx.insert(authAccounts).values({
      accountId: PROTECTED_SUPER_ADMIN_ID,
      id: crypto.randomUUID(),
      password: passwordHash,
      providerId: "credential",
      userId: PROTECTED_SUPER_ADMIN_ID,
    });
    await tx.insert(adminUsers).values({
      displayName: input.displayName,
      loginIdentifier: input.email,
      status: "ACTIVE",
    });
    await tx.insert(auditLogs).values({
      action: "SUPER_ADMIN_BOOTSTRAPPED",
      actorId: "production-bootstrap",
      actorType: "SYSTEM",
      afterJson: { role: "super_admin", status: "ACTIVE" },
      beforeJson: {},
      entityId: PROTECTED_SUPER_ADMIN_ID,
      entityType: "AUTH_USER",
      reason: "Initial production bootstrap",
    });

    return { created: true as const, email: input.email };
  });
}

async function main() {
  const displayName = process.env.BOOTSTRAP_SUPER_ADMIN_DISPLAY_NAME;
  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;

  if (!displayName || !email || !password) {
    throw new Error(
      "BOOTSTRAP_SUPER_ADMIN_DISPLAY_NAME, BOOTSTRAP_SUPER_ADMIN_EMAIL and BOOTSTRAP_SUPER_ADMIN_PASSWORD are required",
    );
  }

  const result = await bootstrapSuperAdmin({ displayName, email, password });
  console.info(result.created ? "Super admin created" : "Super admin already exists");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  await main();
}
