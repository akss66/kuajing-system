import { afterEach, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  authUsers,
  customerUsers,
  customers,
  fulfillmentOrders,
  stores,
  walletAccounts,
} from "@/db/schema";
import { listCustomerManagementRows } from "@/modules/customers/queries";

afterEach(async () => {
  await db.delete(fulfillmentOrders);
  await db.delete(customerUsers);
  await db.delete(authUsers);
  await db.delete(stores);
  await db.delete(walletAccounts);
  await db.delete(customers);
});

test("uses the newest customer mirror when duplicate rows exist and still returns one customer row", async () => {
  const [customer] = await db
    .insert(customers)
    .values({ code: "MIRROR-QUERY", name: "镜像选择客户" })
    .returning({ id: customers.id });
  const oldCreatedAt = new Date("2026-01-10T08:00:00.000Z");
  const latestCreatedAt = new Date("2026-02-10T08:00:00.000Z");

  await db.insert(authUsers).values({
    createdAt: latestCreatedAt,
    customerId: customer.id,
    email: "latest-mirror@test.local",
    id: "auth-latest-mirror",
    name: "最新镜像负责人",
    role: "user",
    updatedAt: latestCreatedAt,
  });
  await db.insert(customerUsers).values([
    {
      createdAt: oldCreatedAt,
      customerId: customer.id,
      displayName: "过期镜像负责人",
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      loginIdentifier: "stale-mirror@test.local",
      status: "DISABLED",
      updatedAt: oldCreatedAt,
    },
    {
      createdAt: latestCreatedAt,
      customerId: customer.id,
      displayName: "最新镜像负责人",
      id: "00000000-0000-4000-8000-000000000001",
      loginIdentifier: "latest-mirror@test.local",
      status: "ACTIVE",
      updatedAt: latestCreatedAt,
    },
  ]);

  const rows = await listCustomerManagementRows();

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    accountDisplayName: "最新镜像负责人",
    accountEmail: "latest-mirror@test.local",
    accountStatus: "ACTIVE",
    customerId: customer.id,
  });
});

test("returns one exact management row per customer without multiplying wallet, store, or order aggregates", async () => {
  const [north, south] = await db
    .insert(customers)
    .values([
      { code: "NORTH-QUERY", name: "华北聚合客户", status: "ACTIVE" },
      { code: "SOUTH-QUERY", name: "华南聚合客户", status: "DISABLED" },
    ])
    .returning({ id: customers.id });

  await db.insert(customerUsers).values([
    {
      customerId: north.id,
      displayName: "华北负责人",
      loginIdentifier: "north-query@test.local",
      status: "ACTIVE",
    },
    {
      customerId: south.id,
      displayName: "华南负责人",
      loginIdentifier: "south-query@test.local",
      status: "DISABLED",
    },
  ]);
  await db.insert(walletAccounts).values([
    { balanceFen: 123_456, customerId: north.id },
    { balanceFen: 987, customerId: south.id },
  ]);

  const insertedStores = await db
    .insert(stores)
    .values([
      { customerId: north.id, name: "华北一店" },
      { customerId: north.id, name: "华北二店" },
      { customerId: south.id, name: "华南一店" },
    ])
    .returning({ customerId: stores.customerId, id: stores.id, name: stores.name });
  const storeId = (name: string) => insertedStores.find((store) => store.name === name)!.id;
  const now = Date.now();

  await db.insert(fulfillmentOrders).values([
    {
      customerId: north.id,
      orderNumber: "NORTH-PENDING-RECENT",
      status: "PENDING_PAYMENT",
      storeId: storeId("华北一店"),
      submittedAt: new Date(now - 29 * 24 * 60 * 60 * 1_000),
      totalAmountFen: 1_000,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
    {
      customerId: north.id,
      orderNumber: "NORTH-PENDING-OLD",
      status: "PENDING_PAYMENT",
      storeId: storeId("华北二店"),
      submittedAt: new Date(now - 31 * 24 * 60 * 60 * 1_000),
      totalAmountFen: 2_000,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
    {
      customerId: north.id,
      orderNumber: "NORTH-EXCEPTION-RECENT",
      paymentMode: "DIRECT_OFFLINE",
      status: "FULFILLMENT_EXCEPTION",
      storeId: storeId("华北一店"),
      submittedAt: new Date(now - 2 * 24 * 60 * 60 * 1_000),
      totalAmountFen: 3_000,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
    {
      customerId: north.id,
      orderNumber: "NORTH-SHIPPED-RECENT",
      paymentMode: "WALLET",
      status: "SHIPPED",
      storeId: storeId("华北二店"),
      submittedAt: new Date(now - 60 * 60 * 1_000),
      totalAmountFen: 4_000,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
    {
      customerId: south.id,
      orderNumber: "SOUTH-PENDING-RECENT",
      status: "PENDING_PAYMENT",
      storeId: storeId("华南一店"),
      submittedAt: new Date(now - 29 * 24 * 60 * 60 * 1_000),
      totalAmountFen: 700,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
    {
      customerId: south.id,
      orderNumber: "SOUTH-EXCEPTION-OLD",
      paymentMode: "MIXED",
      status: "FULFILLMENT_EXCEPTION",
      storeId: storeId("华南一店"),
      submittedAt: new Date(now - 31 * 24 * 60 * 60 * 1_000),
      totalAmountFen: 800,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
  ]);

  const rows = await listCustomerManagementRows();

  expect(rows).toEqual([
    {
      accountDisplayName: "华北负责人",
      accountEmail: "north-query@test.local",
      accountStatus: "ACTIVE",
      balanceFen: 123_456,
      code: "NORTH-QUERY",
      contactName: null,
      customerId: north.id,
      exceptionOrderCount: 1,
      name: "华北聚合客户",
      pendingPaymentFen: 3_000,
      recentOrderCount: 3,
      status: "ACTIVE",
      storeCount: 2,
    },
    {
      accountDisplayName: "华南负责人",
      accountEmail: "south-query@test.local",
      accountStatus: "DISABLED",
      balanceFen: 987,
      code: "SOUTH-QUERY",
      contactName: null,
      customerId: south.id,
      exceptionOrderCount: 1,
      name: "华南聚合客户",
      pendingPaymentFen: 700,
      recentOrderCount: 1,
      status: "DISABLED",
      storeCount: 1,
    },
  ]);
});
