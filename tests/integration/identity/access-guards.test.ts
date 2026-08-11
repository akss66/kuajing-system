import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import { customers, stores } from "@/db/schema";
import {
  assertStoreOwnership,
  requireAdmin,
  requireCustomer,
} from "@/modules/identity/guards";
import type { CustomerPrincipal } from "@/modules/identity/principal";

describe("tenant-aware access guards", () => {
  afterEach(async () => {
    await db.delete(stores);
    await db.delete(customers);
  });

  test("customer cannot access another customer's store", async () => {
    const [customerA, customerB] = await db
      .insert(customers)
      .values([
        { code: `A-${crypto.randomUUID()}`, name: "客户 A" },
        { code: `B-${crypto.randomUUID()}`, name: "客户 B" },
      ])
      .returning({ id: customers.id });
    const [customerBStore] = await db
      .insert(stores)
      .values({ customerId: customerB.id, name: "客户 B 的店铺" })
      .returning({ id: stores.id });

    await expect(
      assertStoreOwnership(customerA.id, customerBStore.id),
    ).rejects.toMatchObject({ code: "FORBIDDEN_STORE" });

    const [matchingStore] = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, customerBStore.id));
    expect(matchingStore.id).toBe(customerBStore.id);
  });

  test("anonymous users cannot pass an admin guard", async () => {
    await expect(requireAdmin(async () => null)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  test("customer principals cannot pass an admin guard", async () => {
    const customerPrincipal: CustomerPrincipal = {
      kind: "CUSTOMER",
      customerId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
    };

    await expect(
      requireAdmin(async () => customerPrincipal),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ADMIN" });
  });

  test("admin principals cannot pass a customer guard", async () => {
    await expect(
      requireCustomer(async () => ({ kind: "ADMIN", userId: crypto.randomUUID() })),
    ).rejects.toMatchObject({ code: "FORBIDDEN_CUSTOMER" });
  });
});
