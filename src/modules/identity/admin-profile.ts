import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { adminUsers, authUsers } from "@/db/schema";

export async function resolveAdminUserId(authUserId: string) {
  const [admin] = await db
    .select({ id: adminUsers.id })
    .from(authUsers)
    .innerJoin(
      adminUsers,
      sql`lower(${adminUsers.loginIdentifier}) = lower(${authUsers.email})`,
    )
    .where(
      and(eq(authUsers.id, authUserId), eq(adminUsers.status, "ACTIVE")),
    )
    .limit(1);
  if (!admin) throw new Error("ADMIN_PROFILE_NOT_FOUND");
  return admin.id;
}
