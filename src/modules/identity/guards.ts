import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { stores } from "@/db/schema";

import type {
  AdminPrincipal,
  CustomerPrincipal,
  PrincipalResolver,
} from "./principal";
import { getCurrentPrincipal } from "./principal";

export class AccessError extends Error {
  constructor(
    public readonly code:
      | "UNAUTHENTICATED"
      | "FORBIDDEN_ADMIN"
      | "FORBIDDEN_CUSTOMER"
      | "FORBIDDEN_STORE",
    public readonly status: 401 | 403,
  ) {
    super(code);
    this.name = "AccessError";
  }
}

const resolveAuthenticatedPrincipal: PrincipalResolver = () =>
  getCurrentPrincipal();

export async function requireAdmin(
  resolvePrincipal: PrincipalResolver = resolveAuthenticatedPrincipal,
): Promise<AdminPrincipal> {
  const principal = await resolvePrincipal();
  if (!principal) throw new AccessError("UNAUTHENTICATED", 401);
  if (principal.kind !== "ADMIN") throw new AccessError("FORBIDDEN_ADMIN", 403);
  return principal;
}

export async function requireCustomer(
  resolvePrincipal: PrincipalResolver = resolveAuthenticatedPrincipal,
): Promise<CustomerPrincipal> {
  const principal = await resolvePrincipal();
  if (!principal) throw new AccessError("UNAUTHENTICATED", 401);
  if (principal.kind !== "CUSTOMER") {
    throw new AccessError("FORBIDDEN_CUSTOMER", 403);
  }
  return principal;
}

export async function assertStoreOwnership(
  customerId: string,
  storeId: string,
): Promise<void> {
  const [ownedStore] = await db
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.customerId, customerId)))
    .limit(1);

  if (!ownedStore) throw new AccessError("FORBIDDEN_STORE", 403);
}
