import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db/client";
import {
  aiSkuMatchRuns,
  aiSkuMatchSuggestions,
  customers,
  inventoryBalances,
  orderImportBatches,
  orderImportRows,
  products,
  skus,
  stores,
} from "@/db/schema";

async function createFixture() {
  const [customer] = await db
    .insert(customers)
    .values({ code: `AI-${crypto.randomUUID()}`, name: "AI 匹配客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "AI 测试店铺" })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: "宠物牵引绳" })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan: 8_000,
      name: "红色款",
      productId: product.id,
      skuCode: `TZX-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      customerId: customer.id,
      expiresAt: new Date(Date.now() + 60_000),
      fileSha256: "a".repeat(64),
      fileSizeBytes: 1,
      originalFileName: "ai.xlsx",
      storeId: store.id,
      totalRows: 1,
      unknownSkuRows: 1,
    })
    .returning();
  const [row] = await db
    .insert(orderImportRows)
    .values({
      batchId: batch.id,
      externalSku: "UNKNOWN-RED",
      quantity: 1,
      rowNumber: 2,
      status: "UNKNOWN_SKU",
    })
    .returning();
  return { batch, customer, row, sku };
}

describe("AI SKU matching schema", () => {
  it("keeps customer access disabled by default and stores bounded feedback records", async () => {
    const fixture = await createFixture();
    expect(fixture.customer.aiSkuMatchEnabled).toBe(false);

    const [run] = await db
      .insert(aiSkuMatchRuns)
      .values({
        actorUserId: "customer-user",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        model: "deepseek-v4-flash",
        promptVersion: "v1",
        rowCount: 1,
      })
      .returning();
    const [suggestion] = await db
      .insert(aiSkuMatchSuggestions)
      .values({
        batchId: fixture.batch.id,
        candidates: [
          {
            confidence: "HIGH",
            rank: 1,
            reason: "商品和颜色一致",
            skuId: fixture.sku.id,
          },
        ],
        customerId: fixture.customer.id,
        expiresAt: run.expiresAt,
        inputFingerprint: "b".repeat(64),
        promptVersion: "v1",
        rowId: fixture.row.id,
        rowRevision: 0,
        runId: run.id,
      })
      .returning();

    await db
      .update(aiSkuMatchSuggestions)
      .set({
        acceptedSkuId: fixture.sku.id,
        decidedAt: new Date(),
        decision: "ACCEPTED",
      })
      .where(eq(aiSkuMatchSuggestions.id, suggestion.id));
    await expect(
      db
        .select({ decision: aiSkuMatchSuggestions.decision })
        .from(aiSkuMatchSuggestions)
        .where(eq(aiSkuMatchSuggestions.id, suggestion.id)),
    ).resolves.toEqual([{ decision: "ACCEPTED" }]);

    await db.delete(aiSkuMatchRuns).where(eq(aiSkuMatchRuns.id, run.id));
    await expect(
      db
        .select({ id: aiSkuMatchSuggestions.id })
        .from(aiSkuMatchSuggestions)
        .where(eq(aiSkuMatchSuggestions.id, suggestion.id)),
    ).resolves.toEqual([]);
  });

  it("rejects an accepted SKU on a suggestion that is still pending", async () => {
    const fixture = await createFixture();
    const [run] = await db
      .insert(aiSkuMatchRuns)
      .values({
        actorUserId: "customer-user",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        expiresAt: new Date(Date.now() + 60_000),
        model: "deepseek-v4-flash",
        promptVersion: "v1",
        rowCount: 1,
      })
      .returning();

    await expect(
      db.insert(aiSkuMatchSuggestions).values({
        acceptedSkuId: fixture.sku.id,
        batchId: fixture.batch.id,
        candidates: [
          {
            confidence: "HIGH",
            rank: 1,
            reason: "商品和颜色一致",
            skuId: fixture.sku.id,
          },
        ],
        customerId: fixture.customer.id,
        expiresAt: run.expiresAt,
        inputFingerprint: "c".repeat(64),
        promptVersion: "v1",
        rowId: fixture.row.id,
        rowRevision: 0,
        runId: run.id,
      }),
    ).rejects.toBeDefined();
  });
});
