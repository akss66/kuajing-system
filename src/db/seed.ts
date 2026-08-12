import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

import { db } from "./client";
import {
  adminUsers,
  authAccounts,
  authUsers,
  customerSkuPrices,
  customerUsers,
  customers,
  inventoryBalances,
  products,
  skus,
  stores,
  walletAccounts,
} from "./schema";

if (process.env.NODE_ENV === "production") {
  throw new Error("Seed data is disabled in production");
}

const ADMIN_EMAIL = "admin@tongzhouxing.local";
const CUSTOMER_EMAIL = "customer@tongzhouxing.local";
const ADMIN_PASSWORD = "TongZhouXing-Admin-2026!";
const CUSTOMER_PASSWORD = "TongZhouXing-Customer-2026!";

async function upsertCredentialUser(input: {
  customerId?: string;
  email: string;
  id: string;
  name: string;
  password: string;
  role: "admin" | "super_admin" | "user";
}) {
  const password = await hashPassword(input.password);
  await db
    .insert(authUsers)
    .values({
      customerId: input.customerId,
      email: input.email,
      id: input.id,
      name: input.name,
      role: input.role,
    })
    .onConflictDoUpdate({
      set: { customerId: input.customerId, name: input.name, role: input.role },
      target: authUsers.email,
    });
  const [user] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, input.email));
  const [account] = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, user.id),
        eq(authAccounts.providerId, "credential"),
      ),
    );
  if (account) {
    await db
      .update(authAccounts)
      .set({ password, updatedAt: new Date() })
      .where(eq(authAccounts.id, account.id));
  } else {
    await db.insert(authAccounts).values({
      accountId: user.id,
      id: crypto.randomUUID(),
      password,
      providerId: "credential",
      userId: user.id,
    });
  }
}

export async function seed() {
  const [customer] = await db
    .insert(customers)
    .values({ code: "DEMO-CUSTOMER", name: "渥太华演示客户" })
    .onConflictDoUpdate({
      set: { name: "渥太华演示客户", updatedAt: new Date() },
      target: customers.code,
    })
    .returning({ id: customers.id });
  await db
    .insert(stores)
    .values({ customerId: customer.id, name: "TEMU 渥太华演示店" })
    .onConflictDoNothing();
  await db
    .insert(walletAccounts)
    .values({ customerId: customer.id })
    .onConflictDoNothing({ target: walletAccounts.customerId });

  await upsertCredentialUser({
    email: ADMIN_EMAIL,
    id: "00000000-0000-4000-8000-00000000a001",
    name: "本地演示管理员",
    password: ADMIN_PASSWORD,
    role: "super_admin",
  });
  await db
    .insert(adminUsers)
    .values({
      displayName: "本地演示管理员",
      loginIdentifier: ADMIN_EMAIL,
      status: "ACTIVE",
    })
    .onConflictDoUpdate({
      set: {
        displayName: "本地演示管理员",
        status: "ACTIVE",
        updatedAt: new Date(),
      },
      target: adminUsers.loginIdentifier,
    });
  await upsertCredentialUser({
    customerId: customer.id,
    email: CUSTOMER_EMAIL,
    id: "00000000-0000-4000-8000-00000000c001",
    name: "渥太华演示客户",
    password: CUSTOMER_PASSWORD,
    role: "user",
  });
  await db
    .insert(customerUsers)
    .values({
      customerId: customer.id,
      displayName: "渝太华演示客户",
      loginIdentifier: CUSTOMER_EMAIL,
      status: "ACTIVE",
    })
    .onConflictDoUpdate({
      set: {
        customerId: customer.id,
        displayName: "渝太华演示客户",
        loginIdentifier: CUSTOMER_EMAIL,
        status: "ACTIVE",
        updatedAt: new Date(),
      },
      target: customerUsers.loginIdentifier,
    });

  let [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.name, "演示头绳"))
    .limit(1);
  if (!product) {
    [product] = await db
      .insert(products)
      .values({ name: "演示头绳" })
      .returning({ id: products.id });
  }
  const [sku] = await db
    .insert(skus)
    .values({
      defaultUnitPriceFen: 690,
      name: "黑色 10 件装",
      productId: product.id,
      skuCode: "TZX-DEMO-001",
    })
    .onConflictDoUpdate({
      set: { defaultUnitPriceFen: 690, name: "黑色 10 件装", updatedAt: new Date() },
      target: skus.skuCode,
    })
    .returning({ id: skus.id });
  await db
    .insert(customerSkuPrices)
    .values({ customerId: customer.id, skuId: sku.id, unitPriceFen: 760 })
    .onConflictDoUpdate({
      set: { active: true, unitPriceFen: 760, updatedAt: new Date() },
      target: [customerSkuPrices.customerId, customerSkuPrices.skuId],
    });
  await db
    .insert(inventoryBalances)
    .values({ skuId: sku.id, totalQuantity: 10 })
    .onConflictDoUpdate({
      set: { totalQuantity: 10, updatedAt: new Date() },
      target: inventoryBalances.skuId,
    });

  console.log("Seed complete: admin@tongzhouxing.local / customer@tongzhouxing.local");
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  await seed();
}
