import { getTableName, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { db } from "@/db/client";
import * as schema from "@/db/schema";

const future = new Date("2026-08-13T12:00:00.000Z");

async function createCustomerAndStore(label: string) {
  const [customer] = await db
    .insert(schema.customers)
    .values({ code: crypto.randomUUID(), name: `${label}客户` })
    .returning();
  const [store] = await db
    .insert(schema.stores)
    .values({ customerId: customer.id, name: `${label}店铺-${crypto.randomUUID()}` })
    .returning();
  return { customer, store };
}

async function createDraft(customerId: string) {
  const rows = await db.execute<{ id: string }>(sql`
    insert into bulk_import_drafts (customer_id, expires_at)
    values (${customerId}, ${future.toISOString()}::timestamptz)
    returning id
  `);
  return rows[0].id;
}

async function createGroup(input: {
  customerId: string;
  draftId: string;
  storeId: string;
}) {
  const rows = await db.execute<{ id: string }>(sql`
    insert into bulk_import_store_groups (draft_id, customer_id, store_id)
    values (${input.draftId}, ${input.customerId}, ${input.storeId})
    returning id
  `);
  return rows[0].id;
}

async function createImportBatch(input: {
  customerId: string;
  storeGroupId: string;
  storeId: string;
}) {
  const [batch] = await db
    .insert(schema.orderImportBatches)
    .values({
      customerId: input.customerId,
      expiresAt: future,
      fileSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      fileSizeBytes: 1,
      originalFileName: `${crypto.randomUUID()}.xlsx`,
      storeGroupId: input.storeGroupId,
      storeId: input.storeId,
    })
    .returning();
  return batch;
}

async function createOrder(input: {
  customerId: string;
  storeId: string;
  totalAmountFen?: number;
}) {
  const [order] = await db
    .insert(schema.fulfillmentOrders)
    .values({
      customerId: input.customerId,
      orderNumber: `TZX-${crypto.randomUUID().slice(0, 24)}`,
      storeId: input.storeId,
      totalAmountFen: input.totalAmountFen ?? 100,
      totalPackageCount: 1,
      totalQuantity: 1,
    })
    .returning();
  return order;
}

async function createSettlement(input: {
  customerId: string;
  offlineAmountFen?: number;
  totalAmountFen?: number;
  walletAmountFen?: number;
}) {
  const totalAmountFen = input.totalAmountFen ?? 100;
  const walletAmountFen = input.walletAmountFen ?? 40;
  const offlineAmountFen =
    input.offlineAmountFen ?? totalAmountFen - walletAmountFen;
  const rows = await db.execute<{ id: string }>(sql`
    insert into settlement_batches (
      batch_number, customer_id, total_amount_fen, wallet_amount_fen,
      offline_amount_fen, payment_due_at, idempotency_key
    ) values (
      ${`JS-${crypto.randomUUID()}`}, ${input.customerId}, ${totalAmountFen},
      ${walletAmountFen}, ${offlineAmountFen},
      ${future.toISOString()}::timestamptz, ${crypto.randomUUID()}
    )
    returning id
  `);
  return rows[0].id;
}

describe("multi-store bulk order schema", () => {
  test("exports the new schema and keeps legacy orders and payment claims readable", async () => {
    const { customer, store } = await createCustomerAndStore("兼容");

    // This insert intentionally supplies the required RED signal before 0010 exists.
    await createDraft(customer.id);

    const expectedTables = [
      [schema.bulkImportDrafts, "bulk_import_drafts"],
      [schema.bulkImportStoreGroups, "bulk_import_store_groups"],
      [schema.fulfillmentOrderImportBatches, "fulfillment_order_import_batches"],
      [schema.settlementBatches, "settlement_batches"],
      [schema.settlementBatchOrders, "settlement_batch_orders"],
      [schema.walletHolds, "wallet_holds"],
      [schema.settlementPaymentClaims, "settlement_payment_claims"],
    ] as const;
    for (const [table, name] of expectedTables) {
      expect(getTableName(table)).toBe(name);
    }

    expect(schema.bulkImportDraftStatus.enumValues).toEqual([
      "DRAFT",
      "PARTIALLY_SUBMITTED",
      "COMPLETED",
      "EXPIRED",
    ]);
    expect(schema.walletHoldStatus.enumValues).toEqual([
      "ACTIVE",
      "CONSUMED",
      "RELEASED",
    ]);
    expect(schema.settlementBatchStatus.enumValues).toEqual([
      "PENDING_PAYMENT",
      "PAYMENT_REPORTED",
      "PAID",
      "REJECTED",
      "WITHDRAWN",
      "CANCELLED",
      "EXPIRED",
    ]);
    expect(schema.settlementPaymentClaimStatus.enumValues).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
    ]);
    expect(schema.fulfillmentPaymentMode.enumValues).toEqual([
      "WALLET",
      "DIRECT_OFFLINE",
      "MIXED",
    ]);

    const order = await createOrder({
      customerId: customer.id,
      storeId: store.id,
    });
    await db.insert(schema.paymentClaims).values({
      amountFen: order.totalAmountFen,
      customerId: customer.id,
      orderId: order.id,
    });
    expect(await db.select().from(schema.fulfillmentOrders)).toContainEqual(order);
    expect(await db.select().from(schema.paymentClaims)).toHaveLength(1);
  });

  test("enforces draft store uniqueness and store/customer ownership", async () => {
    const first = await createCustomerAndStore("甲");
    const second = await createCustomerAndStore("乙");
    const draftId = await createDraft(first.customer.id);
    await createGroup({
      customerId: first.customer.id,
      draftId,
      storeId: first.store.id,
    });

    await expect(
      createGroup({
        customerId: first.customer.id,
        draftId,
        storeId: first.store.id,
      }),
    ).rejects.toThrow();
    await expect(
      createGroup({
        customerId: first.customer.id,
        draftId,
        storeId: second.store.id,
      }),
    ).rejects.toThrow();
    await expect(
      createGroup({
        customerId: second.customer.id,
        draftId,
        storeId: second.store.id,
      }),
    ).rejects.toThrow();
  });

  test("assigns each import file to one matching group and lets an order link multiple files", async () => {
    const first = await createCustomerAndStore("多文件甲");
    const second = await createCustomerAndStore("多文件乙");
    const firstDraftId = await createDraft(first.customer.id);
    const secondDraftId = await createDraft(second.customer.id);
    const firstGroupId = await createGroup({
      customerId: first.customer.id,
      draftId: firstDraftId,
      storeId: first.store.id,
    });
    const secondGroupId = await createGroup({
      customerId: second.customer.id,
      draftId: secondDraftId,
      storeId: second.store.id,
    });
    const firstBatch = await createImportBatch({
      customerId: first.customer.id,
      storeGroupId: firstGroupId,
      storeId: first.store.id,
    });
    const secondBatch = await createImportBatch({
      customerId: first.customer.id,
      storeGroupId: firstGroupId,
      storeId: first.store.id,
    });

    await expect(
      db
        .update(schema.orderImportBatches)
        .set({ storeGroupId: secondGroupId })
        .where(sql`${schema.orderImportBatches.id} = ${firstBatch.id}`),
    ).rejects.toThrow();

    const order = await createOrder({
      customerId: first.customer.id,
      storeId: first.store.id,
    });
    await db.execute(sql`
      insert into fulfillment_order_import_batches (order_id, import_batch_id)
      values
        (${order.id}, ${firstBatch.id}),
        (${order.id}, ${secondBatch.id})
    `);
    const links = await db.execute<{ import_batch_id: string }>(sql`
      select import_batch_id
      from fulfillment_order_import_batches
      where order_id = ${order.id}
    `);
    expect(links).toHaveLength(2);
  });

  test("enforces settlement totals and per-order allocation equations", async () => {
    const { customer, store } = await createCustomerAndStore("分摊");
    await expect(
      db.execute(sql`
        insert into settlement_batches (
          batch_number, customer_id, total_amount_fen, wallet_amount_fen,
          offline_amount_fen, payment_due_at, idempotency_key
        ) values (
          ${`JS-${crypto.randomUUID()}`}, ${customer.id}, 100, 60, 39,
          ${future.toISOString()}::timestamptz, ${crypto.randomUUID()}
        )
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into settlement_batches (
          batch_number, customer_id, total_amount_fen, wallet_amount_fen,
          offline_amount_fen, payment_due_at, idempotency_key
        ) values (
          ${`JS-${crypto.randomUUID()}`}, ${customer.id}, 0, 0, 0,
          ${future.toISOString()}::timestamptz, ${crypto.randomUUID()}
        )
      `),
    ).rejects.toThrow();

    const settlementId = await createSettlement({ customerId: customer.id });
    const order = await createOrder({
      customerId: customer.id,
      storeId: store.id,
    });
    await expect(
      db.execute(sql`
        insert into settlement_batch_orders (
          settlement_batch_id, order_id, customer_id, total_amount_fen,
          wallet_amount_fen, offline_amount_fen
        ) values (${settlementId}, ${order.id}, ${customer.id}, 100, 40, 59)
      `),
    ).rejects.toThrow();
    await db.execute(sql`
      insert into settlement_batch_orders (
        settlement_batch_id, order_id, customer_id, total_amount_fen,
        wallet_amount_fen, offline_amount_fen
      ) values (${settlementId}, ${order.id}, ${customer.id}, 100, 40, 60)
    `);
  });

  test("allows at most one ACTIVE wallet hold per settlement and requires a positive amount", async () => {
    const { customer } = await createCustomerAndStore("冻结");
    const settlementId = await createSettlement({ customerId: customer.id });

    await expect(
      db.execute(sql`
        insert into wallet_holds (customer_id, settlement_batch_id, amount_fen, status)
        values (${customer.id}, ${settlementId}, 0, 'ACTIVE')
      `),
    ).rejects.toThrow();
    await db.execute(sql`
      insert into wallet_holds (customer_id, settlement_batch_id, amount_fen, status)
      values (${customer.id}, ${settlementId}, 40, 'ACTIVE')
    `);
    await expect(
      db.execute(sql`
        insert into wallet_holds (customer_id, settlement_batch_id, amount_fen, status)
        values (${customer.id}, ${settlementId}, 1, 'ACTIVE')
      `),
    ).rejects.toThrow();
  });

  test("enforces pending-claim uniqueness, positive amounts and system-timeout review details", async () => {
    const { customer } = await createCustomerAndStore("声明");
    const settlementId = await createSettlement({ customerId: customer.id });

    await expect(
      db.execute(sql`
        insert into settlement_payment_claims (
          settlement_batch_id, customer_id, amount_fen, status
        ) values (${settlementId}, ${customer.id}, 0, 'PENDING')
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into settlement_payment_claims (
          settlement_batch_id, customer_id, amount_fen, status, reviewed_at
        ) values (${settlementId}, ${customer.id}, 60, 'APPROVED', now())
      `),
    ).rejects.toThrow();
    await db.execute(sql`
      insert into settlement_payment_claims (
        settlement_batch_id, customer_id, amount_fen, status, rejection_reason,
        reviewed_at
      ) values (
        ${settlementId}, ${customer.id}, 60, 'REJECTED',
        '付款声明超过 12 小时未完成核款', now()
      )
    `);
    await db.execute(sql`
      insert into settlement_payment_claims (
        settlement_batch_id, customer_id, amount_fen, status
      ) values (${settlementId}, ${customer.id}, 60, 'PENDING')
    `);
    await expect(
      db.execute(sql`
        insert into settlement_payment_claims (
          settlement_batch_id, customer_id, amount_fen, status
        ) values (${settlementId}, ${customer.id}, 60, 'PENDING')
      `),
    ).rejects.toThrow();
  });

  test("requires reasons and transition timestamps for terminal states", async () => {
    const { customer } = await createCustomerAndStore("状态原因");
    const [admin] = await db
      .insert(schema.adminUsers)
      .values({
        displayName: "核款管理员",
        loginIdentifier: `schema-${crypto.randomUUID()}@test.local`,
      })
      .returning();

    for (const status of ["REJECTED", "WITHDRAWN", "CANCELLED", "EXPIRED"] as const) {
      await expect(
        db.execute(sql`
          insert into settlement_batches (
            batch_number, customer_id, status, status_reason, total_amount_fen,
            wallet_amount_fen, offline_amount_fen, payment_due_at, idempotency_key
          ) values (
            ${`JS-${crypto.randomUUID()}`}, ${customer.id}, ${status}, ' ', 100,
            40, 60, ${future.toISOString()}::timestamptz, ${crypto.randomUUID()}
          )
        `),
      ).rejects.toThrow();
    }

    const settlementId = await createSettlement({ customerId: customer.id });
    await expect(
      db.execute(sql`
        insert into wallet_holds (
          customer_id, settlement_batch_id, amount_fen, status, released_at, release_reason
        ) values (${customer.id}, ${settlementId}, 40, 'RELEASED', now(), ' ')
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into wallet_holds (
          customer_id, settlement_batch_id, amount_fen, status
        ) values (${customer.id}, ${settlementId}, 40, 'CONSUMED')
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into settlement_payment_claims (
          settlement_batch_id, customer_id, amount_fen, status, rejection_reason,
          reviewed_by_admin_user_id, reviewed_at
        ) values (
          ${settlementId}, ${customer.id}, 60, 'REJECTED', ' ', ${admin.id}, now()
        )
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into settlement_payment_claims (
          settlement_batch_id, customer_id, amount_fen, status, withdrawal_reason,
          withdrawn_at
        ) values (${settlementId}, ${customer.id}, 60, 'WITHDRAWN', ' ', now())
      `),
    ).rejects.toThrow();
  });
});
