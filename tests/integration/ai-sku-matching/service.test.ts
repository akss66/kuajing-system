import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db/client";
import {
  aiSkuMatchRuns,
  aiSkuMatchSuggestions,
  customers,
  inventoryBalances,
  orderImportBatches,
  orderImportRows,
  products,
  skuAliases,
  skus,
  stores,
} from "@/db/schema";
import {
  AiSkuMatchError,
  deleteExpiredAiSkuMatchRecords,
  generateAiSkuMatchSuggestions,
  listActiveAiSkuMatchSuggestions,
  rejectAiSkuMatchSuggestion,
} from "@/modules/ai-sku-matching/service";
import type { AiSkuMatchProvider } from "@/modules/ai-sku-matching/types";
import {
  refreshActiveImportPreviewsForAlias,
  updateCustomerImportRowOverride,
} from "@/modules/order-import/service";

const originalAiEnv = {
  AI_SKU_MATCH_ENABLED: process.env.AI_SKU_MATCH_ENABLED,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
};

beforeEach(() => {
  process.env.AI_SKU_MATCH_ENABLED = "true";
  process.env.DEEPSEEK_API_KEY = "integration-test-secret";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalAiEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function createFixture(options: { enabled?: boolean } = {}) {
  const [customer, otherCustomer] = await db
    .insert(customers)
    .values([
      {
        aiSkuMatchEnabled: options.enabled ?? true,
        code: `AI-A-${crypto.randomUUID().slice(0, 20)}`,
        name: "AI 客户 A",
      },
      { code: `AI-B-${crypto.randomUUID().slice(0, 20)}`, name: "AI 客户 B" },
    ])
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: `AI 店铺 ${crypto.randomUUID()}` })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: "反光宠物牵引绳" })
    .returning();
  const [eligibleSku, priceMissingSku, unavailableSku] = await db
    .insert(skus)
    .values([
      {
        cargoUnitPriceMilliYuan: 8_000,
        color: "红色",
        name: "红色款",
        productId: product.id,
        skuCode: `TZX-RED-${crypto.randomUUID()}`,
        specification: "150×80",
      },
      {
        color: "红色",
        name: "无价格款",
        productId: product.id,
        skuCode: `TZX-NO-PRICE-${crypto.randomUUID()}`,
      },
      {
        cargoUnitPriceMilliYuan: 8_000,
        color: "红色",
        name: "已下架款",
        productId: product.id,
        saleStatus: "NOT_SELLABLE",
        skuCode: `TZX-OFF-${crypto.randomUUID()}`,
      },
    ])
    .returning();
  await db.insert(inventoryBalances).values([
    { skuId: eligibleSku.id, totalQuantity: 10 },
    { skuId: priceMissingSku.id, totalQuantity: 10 },
    { skuId: unavailableSku.id, totalQuantity: 10 },
  ]);
  const [batch] = await db
    .insert(orderImportBatches)
    .values({
      customerId: customer.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      fileSha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"),
      fileSizeBytes: 100,
      originalFileName: "ai-orders.xlsx",
      storeId: store.id,
      totalRows: 1,
      unknownSkuRows: 1,
    })
    .returning();
  const [row] = await db
    .insert(orderImportRows)
    .values({
      batchId: batch.id,
      effectiveQuantity: 2,
      externalOrderNo: "PII-ORDER-MUST-NOT-BE-SENT",
      externalSku: "UNKNOWN-RED",
      productAttributes: "颜色：红色；尺寸：150*80",
      productName: "反光宠物牵引绳",
      quantity: 2,
      recipientPayloadEncrypted: "encrypted-pii-must-not-be-sent",
      rowNumber: 2,
      status: "UNKNOWN_SKU",
    })
    .returning();
  return {
    batch,
    customer,
    eligibleSku,
    otherCustomer,
    row,
    store,
  };
}

function acceptingProvider(
  candidateId: string,
  inspect?: (input: Parameters<AiSkuMatchProvider["suggest"]>[0]) => void,
): AiSkuMatchProvider {
  return {
    async suggest(input) {
      inspect?.(input);
      return {
        completionTokens: 20,
        matches: input.rows.map((row) => ({
          rowId: row.rowId,
          suggestions: [
            {
              candidateId,
              confidence: "HIGH" as const,
              reason: "商品、颜色和规格一致",
            },
          ],
        })),
        promptTokens: 100,
      };
    },
  };
}

describe("AI SKU matching service", () => {
  it("sends only eligible catalog candidates and keeps suggestions customer-scoped", async () => {
    const fixture = await createFixture();
    const inspect = vi.fn();

    const result = await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id, inspect) },
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(inspect).toHaveBeenCalledOnce();
    const providerInput = inspect.mock.calls[0]?.[0];
    expect(providerInput.candidates).toEqual([
      expect.objectContaining({ id: fixture.eligibleSku.id }),
    ]);
    expect(JSON.stringify(providerInput)).not.toContain("PII-ORDER-MUST-NOT-BE-SENT");
    expect(JSON.stringify(providerInput)).not.toContain("encrypted-pii-must-not-be-sent");

    const ownSuggestions = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );
    expect(ownSuggestions).toEqual([
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            available: true,
            skuCode: fixture.eligibleSku.skuCode,
          }),
        ],
        rowId: fixture.row.id,
      }),
    ]);
    await expect(
      listActiveAiSkuMatchSuggestions(
        fixture.otherCustomer.id,
        fixture.batch.id,
      ),
    ).resolves.toEqual([]);
  });

  it("fails closed before calling the provider when customer access is disabled", async () => {
    const fixture = await createFixture({ enabled: false });
    const provider = { suggest: vi.fn() } as unknown as AiSkuMatchProvider;

    await expect(
      generateAiSkuMatchSuggestions(
        {
          actorUserId: "customer-user-a",
          batchId: fixture.batch.id,
          customerId: fixture.customer.id,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DISABLED" });
    expect(provider.suggest).not.toHaveBeenCalled();
  });

  it("advances past twenty rows that already have current suggestions", async () => {
    const fixture = await createFixture();
    const extraRows = await db
      .insert(orderImportRows)
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          batchId: fixture.batch.id,
          effectiveQuantity: 1,
          externalSku: `UNKNOWN-RED-${index + 2}`,
          productAttributes: "颜色：红色；尺寸：150*80",
          productName: "反光宠物牵引绳",
          quantity: 1,
          rowNumber: index + 3,
          status: "UNKNOWN_SKU" as const,
        })),
      )
      .returning({ id: orderImportRows.id });

    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const inspectSecondRun = vi.fn();

    const second = await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      {
        provider: acceptingProvider(fixture.eligibleSku.id, inspectSecondRun),
      },
    );

    expect(second).toMatchObject({ status: "SUCCEEDED", suggestionCount: 1 });
    expect(inspectSecondRun).toHaveBeenCalledOnce();
    expect(inspectSecondRun.mock.calls[0]?.[0].rows).toEqual([
      expect.objectContaining({ rowId: extraRows.at(-1)?.id }),
    ]);
  });

  it("serializes the per-customer rate limit to three runs per ten minutes", async () => {
    const fixture = await createFixture();
    await db.insert(aiSkuMatchRuns).values(
      Array.from({ length: 3 }, () => ({
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        expiresAt: new Date(Date.now() + 60_000),
        model: "deepseek-v4-flash",
        promptVersion: "v1",
        rowCount: 1,
      })),
    );
    const provider = { suggest: vi.fn() } as unknown as AiSkuMatchProvider;

    await expect(
      generateAiSkuMatchSuggestions(
        {
          actorUserId: "customer-user-a",
          batchId: fixture.batch.id,
          customerId: fixture.customer.id,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(provider.suggest).not.toHaveBeenCalled();
  });

  it("discards model output when the row changes during the network call", async () => {
    const fixture = await createFixture();
    const provider: AiSkuMatchProvider = {
      async suggest(input) {
        await db
          .update(orderImportRows)
          .set({ revision: 1 })
          .where(eq(orderImportRows.id, fixture.row.id));
        return acceptingProvider(fixture.eligibleSku.id).suggest(input);
      },
    };

    const result = await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider },
    );

    expect(result).toMatchObject({ status: "PARTIAL", suggestionCount: 0 });
    await expect(
      listActiveAiSkuMatchSuggestions(fixture.customer.id, fixture.batch.id),
    ).resolves.toEqual([]);
  });

  it("discards model output when customer access changes during the network call", async () => {
    const fixture = await createFixture();
    const provider: AiSkuMatchProvider = {
      async suggest(input) {
        await db
          .update(customers)
          .set({ aiSkuMatchEnabled: false })
          .where(eq(customers.id, fixture.customer.id));
        return acceptingProvider(fixture.eligibleSku.id).suggest(input);
      },
    };

    const result = await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider },
    );

    expect(result).toMatchObject({ status: "PARTIAL", suggestionCount: 0 });
    await expect(
      listActiveAiSkuMatchSuggestions(fixture.customer.id, fixture.batch.id),
    ).resolves.toEqual([]);
  });

  it("requires a current allowlisted suggestion before marking a row AI_CONFIRMED", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [suggestion] = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );

    const updated = await updateCustomerImportRowOverride({
      actorUserId: "customer-user-a",
      aiSuggestionId: suggestion.id,
      batchId: fixture.batch.id,
      customerId: fixture.customer.id,
      effectiveQuantity: 2,
      expectedRevision: 0,
      rowId: fixture.row.id,
      skuCode: fixture.eligibleSku.skuCode,
    });

    expect(updated).toMatchObject({
      resolutionMethod: "AI_CONFIRMED",
      status: "READY",
    });
    await expect(
      db
        .select({
          acceptedSkuId: aiSkuMatchSuggestions.acceptedSkuId,
          decision: aiSkuMatchSuggestions.decision,
        })
        .from(aiSkuMatchSuggestions)
        .where(eq(aiSkuMatchSuggestions.id, suggestion.id)),
    ).resolves.toEqual([
      { acceptedSkuId: fixture.eligibleSku.id, decision: "ACCEPTED" },
    ]);
    await expect(
      db
        .select({ id: skuAliases.id })
        .from(skuAliases)
        .where(eq(skuAliases.externalSku, "UNKNOWN-RED")),
    ).resolves.toEqual([]);
  });

  it("hides an AI suggestion after deterministic matching resolves the row", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    await db
      .update(orderImportRows)
      .set({
        resolutionMethod: "EXACT",
        resolvedSkuId: fixture.eligibleSku.id,
        status: "READY",
      })
      .where(eq(orderImportRows.id, fixture.row.id));

    await expect(
      listActiveAiSkuMatchSuggestions(fixture.customer.id, fixture.batch.id),
    ).resolves.toEqual([]);
  });

  it("rejects an AI suggestion after deterministic matching resolves the row", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [suggestion] = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );
    await db
      .update(orderImportRows)
      .set({
        resolutionMethod: "EXACT",
        resolvedSkuId: fixture.eligibleSku.id,
        status: "READY",
      })
      .where(eq(orderImportRows.id, fixture.row.id));

    await expect(
      updateCustomerImportRowOverride({
        actorUserId: "customer-user-a",
        aiSuggestionId: suggestion.id,
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        effectiveQuantity: 2,
        expectedRevision: 0,
        rowId: fixture.row.id,
        skuCode: fixture.eligibleSku.skuCode,
      }),
    ).rejects.toMatchObject({ code: "AI_SUGGESTION_INVALID" });
    await expect(
      db
        .select({
          resolutionMethod: orderImportRows.resolutionMethod,
          revision: orderImportRows.revision,
          status: orderImportRows.status,
        })
        .from(orderImportRows)
        .where(eq(orderImportRows.id, fixture.row.id)),
    ).resolves.toEqual([
      { resolutionMethod: "EXACT", revision: 0, status: "READY" },
    ]);
  });

  it("does not revive an old AI suggestion when deterministic matching later hits an inventory error", async () => {
    const fixture = await createFixture();
    await db
      .update(orderImportRows)
      .set({ externalSku: "TZX-LATER-NORMALIZED-LK" })
      .where(eq(orderImportRows.id, fixture.row.id));
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [suggestion] = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );
    await db
      .update(inventoryBalances)
      .set({ totalQuantity: 0 })
      .where(eq(inventoryBalances.skuId, fixture.eligibleSku.id));
    await db.insert(skuAliases).values({
      externalSku: "TZX-LATER-NORMALIZED",
      skuId: fixture.eligibleSku.id,
      storeId: fixture.store.id,
    });
    await db.transaction((tx) =>
      refreshActiveImportPreviewsForAlias(tx, {
        actorUserId: "admin-user",
        externalSku: "TZX-LATER-NORMALIZED",
        skuId: fixture.eligibleSku.id,
        storeId: fixture.store.id,
      }),
    );
    await db
      .update(inventoryBalances)
      .set({ totalQuantity: 10 })
      .where(eq(inventoryBalances.skuId, fixture.eligibleSku.id));
    const [currentRow] = await db
      .select({ revision: orderImportRows.revision, status: orderImportRows.status })
      .from(orderImportRows)
      .where(eq(orderImportRows.id, fixture.row.id));

    expect(currentRow).toMatchObject({ status: "UNKNOWN_SKU" });
    await expect(
      listActiveAiSkuMatchSuggestions(fixture.customer.id, fixture.batch.id),
    ).resolves.toEqual([]);
    await expect(
      updateCustomerImportRowOverride({
        actorUserId: "customer-user-a",
        aiSuggestionId: suggestion.id,
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        effectiveQuantity: 2,
        expectedRevision: currentRow.revision,
        rowId: fixture.row.id,
        skuCode: fixture.eligibleSku.skuCode,
      }),
    ).rejects.toMatchObject({ code: "AI_SUGGESTION_INVALID" });
  });

  it("keeps the row unchanged when suggested inventory changes before confirmation", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [suggestion] = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );
    await db
      .update(inventoryBalances)
      .set({ totalQuantity: 0 })
      .where(eq(inventoryBalances.skuId, fixture.eligibleSku.id));

    await expect(
      updateCustomerImportRowOverride({
        actorUserId: "customer-user-a",
        aiSuggestionId: suggestion.id,
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        effectiveQuantity: 2,
        expectedRevision: 0,
        rowId: fixture.row.id,
        skuCode: fixture.eligibleSku.skuCode,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(
      db
        .select({
          resolvedSkuId: orderImportRows.resolvedSkuId,
          revision: orderImportRows.revision,
          status: orderImportRows.status,
        })
        .from(orderImportRows)
        .where(eq(orderImportRows.id, fixture.row.id)),
    ).resolves.toEqual([
      { resolvedSkuId: null, revision: 0, status: "UNKNOWN_SKU" },
    ]);
  });

  it("rejects a suggested SKU that is taken off sale before confirmation", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [suggestion] = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );
    await db
      .update(skus)
      .set({ saleStatus: "NOT_SELLABLE" })
      .where(eq(skus.id, fixture.eligibleSku.id));

    await expect(
      updateCustomerImportRowOverride({
        actorUserId: "customer-user-a",
        aiSuggestionId: suggestion.id,
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
        effectiveQuantity: 2,
        expectedRevision: 0,
        rowId: fixture.row.id,
        skuCode: fixture.eligibleSku.skuCode,
      }),
    ).rejects.toMatchObject({ code: "SKU_NOT_AVAILABLE" });
    await expect(
      db
        .select({ decision: aiSkuMatchSuggestions.decision })
        .from(aiSkuMatchSuggestions)
        .where(eq(aiSkuMatchSuggestions.id, suggestion.id)),
    ).resolves.toEqual([{ decision: "PENDING" }]);
  });

  it("records rejection without mutating the import row", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [suggestion] = await listActiveAiSkuMatchSuggestions(
      fixture.customer.id,
      fixture.batch.id,
    );

    await rejectAiSkuMatchSuggestion({
      actorUserId: "customer-user-a",
      batchId: fixture.batch.id,
      customerId: fixture.customer.id,
      suggestionId: suggestion.id,
    });

    await expect(
      db
        .select({
          resolvedSkuId: orderImportRows.resolvedSkuId,
          revision: orderImportRows.revision,
          status: orderImportRows.status,
        })
        .from(orderImportRows)
        .where(eq(orderImportRows.id, fixture.row.id)),
    ).resolves.toEqual([
      { resolvedSkuId: null, revision: 0, status: "UNKNOWN_SKU" },
    ]);
    await expect(
      db
        .select({ decision: aiSkuMatchSuggestions.decision })
        .from(aiSkuMatchSuggestions)
        .where(eq(aiSkuMatchSuggestions.id, suggestion.id)),
    ).resolves.toEqual([{ decision: "REJECTED" }]);
  });

  it("deletes expired runs and cascades their de-identified suggestions", async () => {
    const fixture = await createFixture();
    await generateAiSkuMatchSuggestions(
      {
        actorUserId: "customer-user-a",
        batchId: fixture.batch.id,
        customerId: fixture.customer.id,
      },
      { provider: acceptingProvider(fixture.eligibleSku.id) },
    );
    const [run] = await db
      .select({ id: aiSkuMatchRuns.id })
      .from(aiSkuMatchRuns)
      .where(eq(aiSkuMatchRuns.batchId, fixture.batch.id));
    const oldCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    await db
      .update(aiSkuMatchRuns)
      .set({ createdAt: oldCreatedAt, expiresAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(aiSkuMatchRuns.id, run.id));

    await expect(
      deleteExpiredAiSkuMatchRecords(new Date("2026-01-03T00:00:00.000Z")),
    ).resolves.toBe(1);
    await expect(
      db
        .select({ id: aiSkuMatchSuggestions.id })
        .from(aiSkuMatchSuggestions)
        .where(and(eq(aiSkuMatchSuggestions.runId, run.id))),
    ).resolves.toEqual([]);
  });

  it("uses safe typed errors instead of exposing provider or database details", () => {
    expect(new AiSkuMatchError("PROVIDER_FAILED", "safe")).toMatchObject({
      code: "PROVIDER_FAILED",
      message: "safe",
    });
  });
});
