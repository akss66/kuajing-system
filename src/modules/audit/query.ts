import { and, desc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";

export async function listAuditLogs(filters: {
  action?: string;
  actorType?: "ADMIN" | "CUSTOMER" | "SYSTEM";
  entityType?: string;
  from?: Date;
  to?: Date;
}) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        filters.action ? eq(auditLogs.action, filters.action) : undefined,
        filters.actorType ? eq(auditLogs.actorType, filters.actorType) : undefined,
        filters.entityType
          ? eq(auditLogs.entityType, filters.entityType)
          : undefined,
        filters.from ? gte(auditLogs.createdAt, filters.from) : undefined,
        filters.to ? lte(auditLogs.createdAt, filters.to) : undefined,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);
}
