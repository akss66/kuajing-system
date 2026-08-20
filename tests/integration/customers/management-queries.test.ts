import { afterEach, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  authUsers,
  customerUsers,
  customers,
  fulfillmentOrders,
  stores,
  walletAccounts,
  walletTransactions,
} from "@/db/schema";
import {
  getCustomerManagementDetail,
  listCustomerManagementRows,
} from "@/modules/customers/queries";

afterEach(async () => {
  await db.delete(walletTransactions);
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
      cancelledAt: new Date(now - 30 * 60 * 1_000),
      cancelReason: "测试取消，不计入有效订单",
      customerId: north.id,
      orderNumber: "NORTH-CANCELLED-RECENT",
      status: "CANCELLED",
      storeId: storeId("华北一店"),
      submittedAt: new Date(now - 30 * 60 * 1_000),
      totalAmountFen: 99_999,
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

test("returns a complete empty-account detail without failing when no customer mirror exists", async () => {
  const [customer] = await db
    .insert(customers)
    .values({ code: "NO-DETAIL-MIRROR", name: "无账号镜像客户" })
    .returning({ id: customers.id });
  await db.insert(walletAccounts).values({ balanceFen: 7_250, customerId: customer.id });
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "无账号客户一店" })
    .returning();

  const detail = await getCustomerManagementDetail(customer.id);

  expect(detail.account).toBeNull();
  expect(detail.stores).toEqual([store]);
  expect(detail.summary).toEqual({
    balanceFen: 7_250,
    pendingPaymentFen: 0,
    recentOrderCount: 0,
    storeCount: 1,
  });
  expect(detail.recentOrders).toEqual([]);
  expect(detail.recentTransactions).toEqual([]);
});

test("returns the newest customer mirror identity without changing the remaining detail data", async () => {
  const [customer] = await db
    .insert(customers)
    .values({ code: "DUPLICATE-DETAIL-MIRROR", name: "重复账号镜像客户" })
    .returning({ id: customers.id });
  const oldCreatedAt = new Date("2026-01-10T08:00:00.000Z");
  const latestCreatedAt = new Date("2026-02-10T08:00:00.000Z");
  const latestMirrorId = "00000000-0000-4000-8000-000000000202";

  await db.insert(customerUsers).values([
    {
      createdAt: oldCreatedAt,
      customerId: customer.id,
      displayName: "过期详情负责人",
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      loginIdentifier: "stale-detail-mirror@test.local",
      status: "ACTIVE",
      updatedAt: oldCreatedAt,
    },
    {
      createdAt: latestCreatedAt,
      customerId: customer.id,
      displayName: "最新详情负责人",
      id: latestMirrorId,
      loginIdentifier: "latest-detail-mirror@test.local",
      status: "DISABLED",
      updatedAt: latestCreatedAt,
    },
  ]);
  await db.insert(walletAccounts).values({ balanceFen: 8_800, customerId: customer.id });
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "重复账号客户一店" })
    .returning();

  const detail = await getCustomerManagementDetail(customer.id);

  expect(detail.account).toEqual({
    displayName: "最新详情负责人",
    email: "latest-detail-mirror@test.local",
    id: latestMirrorId,
    status: "DISABLED",
  });
  expect(detail.stores).toEqual([store]);
  expect(detail.summary).toEqual({
    balanceFen: 8_800,
    pendingPaymentFen: 0,
    recentOrderCount: 0,
    storeCount: 1,
  });
  expect(detail.recentOrders).toEqual([]);
  expect(detail.recentTransactions).toEqual([]);
});

test("returns exact isolated customer detail summaries and at most 20 deterministically ordered recent rows", async () => {
  const [customer, otherCustomer] = await db
    .insert(customers)
    .values([
      { code: "DETAIL-QUERY", name: "详情聚合客户" },
      { code: "OTHER-DETAIL", name: "其他客户" },
    ])
    .returning({ id: customers.id });

  await db.insert(customerUsers).values([
    {
      customerId: customer.id,
      displayName: "详情负责人",
      loginIdentifier: "detail-query@test.local",
    },
    {
      customerId: otherCustomer.id,
      displayName: "其他负责人",
      loginIdentifier: "other-detail@test.local",
    },
  ]);
  await db.insert(walletAccounts).values([
    { balanceFen: 123_456, customerId: customer.id },
    { balanceFen: 999_999, customerId: otherCustomer.id },
  ]);

  const [firstStore, secondStore, otherStore] = await db
    .insert(stores)
    .values([
      { customerId: customer.id, name: "详情一店" },
      { customerId: customer.id, name: "详情二店" },
      { customerId: otherCustomer.id, name: "其他店铺" },
    ])
    .returning({ id: stores.id });

  const submittedAt = new Date();
  const targetOrders = Array.from({ length: 22 }, (_, index) => {
    const sequence = index + 1;
    const pending = sequence <= 3;
    const cancelled = sequence === 4;

    return {
      cancelledAt: cancelled ? submittedAt : null,
      cancelReason: cancelled ? "测试取消，不计入有效订单" : null,
      customerId: customer.id,
      id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      orderNumber: `DETAIL-${String(sequence).padStart(2, "0")}`,
      paymentMode: pending ? null : ("WALLET" as const),
      status: pending
        ? ("PENDING_PAYMENT" as const)
        : cancelled
          ? ("CANCELLED" as const)
          : ("SHIPPED" as const),
      storeId: sequence % 2 === 0 ? secondStore.id : firstStore.id,
      submittedAt,
      totalAmountFen: pending ? sequence * 100 : 1_000 + sequence,
      totalPackageCount: 1,
      totalQuantity: 1,
    };
  });
  await db.insert(fulfillmentOrders).values([
    ...targetOrders,
    {
      customerId: customer.id,
      id: "10000000-0000-4000-8000-999999999999",
      orderNumber: "DETAIL-OLD-PENDING",
      status: "PENDING_PAYMENT",
      storeId: firstStore.id,
      submittedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000),
      totalAmountFen: 400,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
    {
      customerId: otherCustomer.id,
      id: "20000000-0000-4000-8000-999999999999",
      orderNumber: "OTHER-NEWEST",
      paymentMode: "WALLET",
      status: "SHIPPED",
      storeId: otherStore.id,
      submittedAt: new Date(Date.now() + 60_000),
      totalAmountFen: 88_888,
      totalPackageCount: 1,
      totalQuantity: 1,
    },
  ]);

  const createdAt = new Date();
  await db.insert(walletTransactions).values([
    ...Array.from({ length: 22 }, (_, index) => {
      const sequence = index + 1;
      return {
        actorId: "detail-test-admin",
        actorType: "ADMIN" as const,
        afterBalanceFen: sequence * 10,
        beforeBalanceFen: (sequence - 1) * 10,
        createdAt,
        customerId: customer.id,
        deltaFen: 10,
        id: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        reason: `详情充值-${String(sequence).padStart(2, "0")}`,
        transactionType: "ADMIN_CREDIT" as const,
      };
    }),
    {
      actorId: "other-test-admin",
      actorType: "ADMIN",
      afterBalanceFen: 999_999,
      beforeBalanceFen: 999_899,
      createdAt: new Date(Date.now() + 60_000),
      customerId: otherCustomer.id,
      deltaFen: 100,
      id: "40000000-0000-4000-8000-999999999999",
      reason: "其他客户充值",
      transactionType: "ADMIN_CREDIT",
    },
  ]);

  const detail = await getCustomerManagementDetail(customer.id);

  expect(detail.summary).toEqual({
    balanceFen: 123_456,
    pendingPaymentFen: 1_000,
    recentOrderCount: 21,
    storeCount: 2,
  });
  expect(detail.recentOrders).toHaveLength(20);
  expect(detail.recentOrders[0]).toEqual({
    id: "10000000-0000-4000-8000-000000000022",
    orderNumber: "DETAIL-22",
    status: "SHIPPED",
    storeName: "详情二店",
    submittedAt,
    totalAmountFen: 1_022,
  });
  expect(
    detail.recentOrders.map(({ id, orderNumber, storeName }) => ({
      id,
      orderNumber,
      storeName,
    })),
  ).toEqual(
    Array.from({ length: 20 }, (_, index) => {
      const sequence = 22 - index;
      return {
        id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        orderNumber: `DETAIL-${String(sequence).padStart(2, "0")}`,
        storeName: sequence % 2 === 0 ? "详情二店" : "详情一店",
      };
    }),
  );
  expect(detail.recentTransactions).toHaveLength(20);
  expect(detail.recentTransactions[0]).toEqual({
    afterBalanceFen: 220,
    createdAt,
    deltaFen: 10,
    id: "30000000-0000-4000-8000-000000000022",
    reason: "详情充值-22",
    transactionType: "ADMIN_CREDIT",
  });
  expect(
    detail.recentTransactions.map(({ afterBalanceFen, id, reason }) => ({
      afterBalanceFen,
      id,
      reason,
    })),
  ).toEqual(
    Array.from({ length: 20 }, (_, index) => {
      const sequence = 22 - index;
      return {
        afterBalanceFen: sequence * 10,
        id: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        reason: `详情充值-${String(sequence).padStart(2, "0")}`,
      };
    }),
  );
  expect(detail.recentOrders.every((order) => order.orderNumber.startsWith("DETAIL-"))).toBe(true);
  expect(
    detail.recentTransactions.every((transaction) => transaction.reason.startsWith("详情充值-")),
  ).toBe(true);
});

test("preserves the missing-customer error contract", async () => {
  await expect(
    getCustomerManagementDetail("00000000-0000-4000-8000-000000000000"),
  ).rejects.toThrow("CUSTOMER_NOT_FOUND");
});
