import { createHash } from "node:crypto";

import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  aiSkuMatchRuns,
  aiSkuMatchSuggestions,
  auditLogs,
  customers,
  inventoryBalances,
  inventoryReservations,
  orderImportBatches,
  orderImportRows,
  products,
  skus,
  type AiSkuMatchCandidateSnapshot,
} from "@/db/schema";

import { shortlistSkuCandidates } from "./candidate-ranking";
import { readAiSkuMatchConfig } from "./config";
import {
  AiSkuMatchProviderError,
  createDeepSeekSkuMatchProvider,
} from "./deepseek-provider";
import type {
  AiSkuMatchCandidateInput,
  AiSkuMatchProvider,
  AiSkuMatchProviderInput,
} from "./types";

const PROMPT_VERSION = "v1";
const MAX_ROWS_PER_RUN = 20;
const MAX_CANDIDATES_PER_ROW = 20;
const RATE_LIMIT_RUNS = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class AiSkuMatchError extends Error {
  constructor(
    public readonly code:
      | "ACCESS_DISABLED"
      | "NO_ELIGIBLE_ROWS"
      | "PREVIEW_EXPIRED"
      | "PREVIEW_NOT_FOUND"
      | "PROVIDER_FAILED"
      | "RATE_LIMITED"
      | "SUGGESTION_NOT_FOUND"
      | "SUGGESTION_STALE"
      | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "AiSkuMatchError";
  }
}

type CatalogCandidate = AiSkuMatchCandidateInput & {
  availableQuantity: number;
  unitPriceMilliYuan: number;
};

type PreparedRow = {
  candidateIds: string[];
  effectiveQuantity: number;
  externalSku: string | null;
  inputFingerprint: string;
  productAttributes: string | null;
  productName: string | null;
  revision: number;
  rowId: string;
};

export type AiSkuMatchSuggestionView = {
  id: string;
  rowId: string;
  rowRevision: number;
  candidates: Array<{
    available: boolean;
    availableQuantity: number;
    color: string | null;
    combination: string | null;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    name: string;
    productName: string;
    rank: number;
    reason: string;
    skuCode: string;
    skuId: string;
    specification: string | null;
    unitPriceMilliYuan: number | null;
  }>;
};

function boundedText(value: string | null, maxLength: number) {
  if (!value) return null;
  return value.normalize("NFKC").slice(0, maxLength);
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pseudonymousUserId(customerId: string) {
  return `customer_${createHash("sha256").update(customerId).digest("hex").slice(0, 24)}`;
}

function activeReservationSubquery(tx: DbTransaction) {
  return tx
    .select({
      quantity:
        sql<number>`coalesce(sum(${inventoryReservations.quantity}), 0)::int`
          .mapWith(Number)
          .as("reserved_quantity"),
      skuId: inventoryReservations.skuId,
    })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.status, "ACTIVE"))
    .groupBy(inventoryReservations.skuId)
    .as("ai_sku_match_active_reservations");
}

function previewDemandSubquery(tx: DbTransaction, batchId: string) {
  return tx
    .select({
      quantity:
        sql<number>`coalesce(sum(${orderImportRows.effectiveQuantity}), 0)::int`
          .mapWith(Number)
          .as("preview_quantity"),
      skuId: orderImportRows.resolvedSkuId,
    })
    .from(orderImportRows)
    .where(
      and(
        eq(orderImportRows.batchId, batchId),
        eq(orderImportRows.status, "READY"),
        eq(orderImportRows.fulfillmentMode, "SYSTEM_SKU"),
        isNotNull(orderImportRows.resolvedSkuId),
      ),
    )
    .groupBy(orderImportRows.resolvedSkuId)
    .as("ai_sku_match_preview_demand");
}

async function loadEligibleCatalog(
  tx: DbTransaction,
  batchId: string,
): Promise<CatalogCandidate[]> {
  const activeReservations = activeReservationSubquery(tx);
  const previewDemand = previewDemandSubquery(tx, batchId);
  return tx
    .select({
      availableQuantity:
        sql<number>`greatest(coalesce(${inventoryBalances.totalQuantity}, 0) - coalesce(${activeReservations.quantity}, 0) - coalesce(${previewDemand.quantity}, 0), 0)::int`.mapWith(
          Number,
        ),
      color: skus.color,
      combination: skus.combination,
      id: skus.id,
      name: skus.name,
      productName: products.name,
      skuCode: skus.skuCode,
      specification: skus.specification,
      unitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .leftJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .leftJoin(activeReservations, eq(activeReservations.skuId, skus.id))
    .leftJoin(previewDemand, eq(previewDemand.skuId, skus.id))
    .where(
      and(
        eq(products.status, "ACTIVE"),
        eq(skus.lifecycleStatus, "ACTIVE"),
        eq(skus.saleStatus, "SELLABLE"),
        isNull(skus.archivedAt),
        isNotNull(skus.cargoUnitPriceMilliYuan),
      ),
    ) as Promise<CatalogCandidate[]>;
}

async function loadCurrentCandidateStates(
  tx: DbTransaction,
  batchId: string,
  skuIds: readonly string[],
) {
  if (skuIds.length === 0) return [];
  const activeReservations = activeReservationSubquery(tx);
  const previewDemand = previewDemandSubquery(tx, batchId);
  return tx
    .select({
      archivedAt: skus.archivedAt,
      availableQuantity:
        sql<number>`greatest(coalesce(${inventoryBalances.totalQuantity}, 0) - coalesce(${activeReservations.quantity}, 0) - coalesce(${previewDemand.quantity}, 0), 0)::int`.mapWith(
          Number,
        ),
      color: skus.color,
      combination: skus.combination,
      id: skus.id,
      lifecycleStatus: skus.lifecycleStatus,
      name: skus.name,
      productName: products.name,
      productStatus: products.status,
      saleStatus: skus.saleStatus,
      skuCode: skus.skuCode,
      specification: skus.specification,
      unitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
    })
    .from(skus)
    .innerJoin(products, eq(products.id, skus.productId))
    .leftJoin(inventoryBalances, eq(inventoryBalances.skuId, skus.id))
    .leftJoin(activeReservations, eq(activeReservations.skuId, skus.id))
    .leftJoin(previewDemand, eq(previewDemand.skuId, skus.id))
    .where(inArray(skus.id, [...skuIds]));
}

function baseCandidateAvailable(candidate: {
  archivedAt: Date | null;
  lifecycleStatus: string;
  productStatus: string;
  saleStatus: string;
  unitPriceMilliYuan: number | null;
}) {
  return (
    candidate.archivedAt === null &&
    candidate.lifecycleStatus === "ACTIVE" &&
    candidate.productStatus === "ACTIVE" &&
    candidate.saleStatus === "SELLABLE" &&
    candidate.unitPriceMilliYuan !== null
  );
}

export async function getAiSkuMatchAvailability(customerId: string) {
  if (!readAiSkuMatchConfig().enabled) return { enabled: false as const };
  const [customer] = await db
    .select({
      aiSkuMatchEnabled: customers.aiSkuMatchEnabled,
      status: customers.status,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return {
    enabled:
      customer?.status === "ACTIVE" && customer.aiSkuMatchEnabled === true,
  };
}

export async function listActiveAiSkuMatchSuggestions(
  customerId: string,
  batchId: string,
  now = new Date(),
): Promise<AiSkuMatchSuggestionView[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        batchId: aiSkuMatchSuggestions.batchId,
        candidates: aiSkuMatchSuggestions.candidates,
        effectiveQuantity: orderImportRows.effectiveQuantity,
        id: aiSkuMatchSuggestions.id,
        quantity: orderImportRows.quantity,
        rowId: aiSkuMatchSuggestions.rowId,
        rowNumber: orderImportRows.rowNumber,
        rowRevision: aiSkuMatchSuggestions.rowRevision,
      })
      .from(aiSkuMatchSuggestions)
      .innerJoin(
        orderImportRows,
        eq(orderImportRows.id, aiSkuMatchSuggestions.rowId),
      )
      .innerJoin(
        orderImportBatches,
        eq(orderImportBatches.id, aiSkuMatchSuggestions.batchId),
      )
      .where(
        and(
          eq(aiSkuMatchSuggestions.customerId, customerId),
          eq(aiSkuMatchSuggestions.batchId, batchId),
          eq(aiSkuMatchSuggestions.decision, "PENDING"),
          eq(aiSkuMatchSuggestions.promptVersion, PROMPT_VERSION),
          eq(orderImportBatches.customerId, customerId),
          eq(orderImportBatches.status, "PREVIEW"),
          eq(orderImportRows.revision, aiSkuMatchSuggestions.rowRevision),
          gt(orderImportBatches.expiresAt, now),
          gt(aiSkuMatchSuggestions.expiresAt, now),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber));
    const skuIds = [
      ...new Set(rows.flatMap((row) => row.candidates.map((item) => item.skuId))),
    ];
    const current = await loadCurrentCandidateStates(tx, batchId, skuIds);
    const currentById = new Map(current.map((candidate) => [candidate.id, candidate]));
    return rows.map((row) => {
      const required = row.effectiveQuantity ?? row.quantity ?? 0;
      return {
        candidates: [...row.candidates]
          .sort((left, right) => left.rank - right.rank)
          .flatMap((snapshot) => {
            const candidate = currentById.get(snapshot.skuId);
            if (!candidate) return [];
            return [
              {
                available:
                  baseCandidateAvailable(candidate) &&
                  candidate.availableQuantity >= required,
                availableQuantity: Math.max(candidate.availableQuantity, 0),
                color: candidate.color,
                combination: candidate.combination,
                confidence: snapshot.confidence,
                name: candidate.name,
                productName: candidate.productName,
                rank: snapshot.rank,
                reason: snapshot.reason,
                skuCode: candidate.skuCode,
                skuId: candidate.id,
                specification: candidate.specification,
                unitPriceMilliYuan: candidate.unitPriceMilliYuan,
              },
            ];
          }),
        id: row.id,
        rowId: row.rowId,
        rowRevision: row.rowRevision,
      };
    });
  });
}

async function prepareGeneration(
  input: { actorUserId: string; batchId: string; customerId: string },
  now: Date,
  model: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.customerId}, 0))`,
    );
    const [customer] = await tx
      .select({
        aiSkuMatchEnabled: customers.aiSkuMatchEnabled,
        status: customers.status,
      })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    if (
      !customer ||
      customer.status !== "ACTIVE" ||
      !customer.aiSkuMatchEnabled
    ) {
      throw new AiSkuMatchError(
        "ACCESS_DISABLED",
        "该账号尚未开放智能 SKU 推荐",
      );
    }
    const [batch] = await tx
      .select({
        expiresAt: orderImportBatches.expiresAt,
        id: orderImportBatches.id,
        status: orderImportBatches.status,
      })
      .from(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
        ),
      )
      .limit(1);
    if (!batch) {
      throw new AiSkuMatchError("PREVIEW_NOT_FOUND", "找不到该导入预览");
    }
    if (batch.status !== "PREVIEW" || batch.expiresAt <= now) {
      throw new AiSkuMatchError(
        "PREVIEW_EXPIRED",
        "导入预览已过期或不能修改",
      );
    }

    await tx
      .update(aiSkuMatchSuggestions)
      .set({ decision: "STALE", decidedAt: now })
      .where(
        and(
          eq(aiSkuMatchSuggestions.customerId, input.customerId),
          eq(aiSkuMatchSuggestions.batchId, input.batchId),
          eq(aiSkuMatchSuggestions.decision, "PENDING"),
          lte(aiSkuMatchSuggestions.expiresAt, now),
        ),
      );

    const unknownRows = await tx
      .select({
        effectiveQuantity: orderImportRows.effectiveQuantity,
        externalSku: orderImportRows.externalSku,
        productAttributes: orderImportRows.productAttributes,
        productName: orderImportRows.productName,
        quantity: orderImportRows.quantity,
        revision: orderImportRows.revision,
        rowId: orderImportRows.id,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, batch.id),
          eq(orderImportRows.fulfillmentMode, "SYSTEM_SKU"),
          eq(orderImportRows.status, "UNKNOWN_SKU"),
        ),
      )
      .orderBy(asc(orderImportRows.rowNumber))
      .limit(MAX_ROWS_PER_RUN);
    if (unknownRows.length === 0) {
      throw new AiSkuMatchError(
        "NO_ELIGIBLE_ROWS",
        "当前没有可智能推荐的待匹配行",
      );
    }

    const existing = await tx
      .select({
        rowId: aiSkuMatchSuggestions.rowId,
        rowRevision: aiSkuMatchSuggestions.rowRevision,
      })
      .from(aiSkuMatchSuggestions)
      .where(
        and(
          eq(aiSkuMatchSuggestions.customerId, input.customerId),
          eq(aiSkuMatchSuggestions.batchId, input.batchId),
          eq(aiSkuMatchSuggestions.decision, "PENDING"),
          eq(aiSkuMatchSuggestions.promptVersion, PROMPT_VERSION),
          gt(aiSkuMatchSuggestions.expiresAt, now),
          inArray(
            aiSkuMatchSuggestions.rowId,
            unknownRows.map((row) => row.rowId),
          ),
        ),
      );
    const cached = new Set(
      existing.map((row) => `${row.rowId}:${row.rowRevision}`),
    );
    const rowsToSend = unknownRows.filter(
      (row) => !cached.has(`${row.rowId}:${row.revision}`),
    );
    if (rowsToSend.length === 0) return { kind: "CACHED" as const };

    const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
    const [recent] = await tx
      .select({ value: count() })
      .from(aiSkuMatchRuns)
      .where(
        and(
          eq(aiSkuMatchRuns.customerId, input.customerId),
          gte(aiSkuMatchRuns.createdAt, windowStart),
        ),
      );
    if (Number(recent?.value ?? 0) >= RATE_LIMIT_RUNS) {
      throw new AiSkuMatchError(
        "RATE_LIMITED",
        "智能推荐操作过于频繁，请稍后再试",
      );
    }

    const catalog = await loadEligibleCatalog(tx, batch.id);
    const providerCandidates = new Map<string, AiSkuMatchCandidateInput>();
    const preparedRows: PreparedRow[] = [];
    for (const row of rowsToSend) {
      const effectiveQuantity = row.effectiveQuantity ?? row.quantity;
      if (!effectiveQuantity || effectiveQuantity <= 0) continue;
      const shortlisted = shortlistSkuCandidates(
        {
          externalSku: row.externalSku,
          productAttributes: row.productAttributes,
          productName: row.productName,
        },
        catalog.filter(
          (candidate) => candidate.availableQuantity >= effectiveQuantity,
        ),
        MAX_CANDIDATES_PER_ROW,
      );
      if (shortlisted.length === 0) continue;
      for (const candidate of shortlisted) {
        providerCandidates.set(candidate.id, {
          color: candidate.color,
          combination: candidate.combination,
          id: candidate.id,
          name: candidate.name,
          productName: candidate.productName,
          skuCode: candidate.skuCode,
          specification: candidate.specification,
        });
      }
      const fingerprintInput = {
        candidateIds: shortlisted.map((candidate) => candidate.id),
        externalSku: boundedText(row.externalSku, 160),
        productAttributes: boundedText(row.productAttributes, 500),
        productName: boundedText(row.productName, 240),
        revision: row.revision,
      };
      preparedRows.push({
        candidateIds: fingerprintInput.candidateIds,
        effectiveQuantity,
        externalSku: fingerprintInput.externalSku,
        inputFingerprint: fingerprint(fingerprintInput),
        productAttributes: fingerprintInput.productAttributes,
        productName: fingerprintInput.productName,
        revision: row.revision,
        rowId: row.rowId,
      });
    }
    if (preparedRows.length === 0) {
      throw new AiSkuMatchError(
        "NO_ELIGIBLE_ROWS",
        "当前没有库存充足的可售候选 SKU",
      );
    }
    const retentionExpiresAt = new Date(now.getTime() + RETENTION_MS);
    const suggestionExpiresAt =
      batch.expiresAt < retentionExpiresAt
        ? batch.expiresAt
        : retentionExpiresAt;
    const [run] = await tx
      .insert(aiSkuMatchRuns)
      .values({
        actorUserId: input.actorUserId,
        batchId: batch.id,
        customerId: input.customerId,
        expiresAt: retentionExpiresAt,
        model,
        promptVersion: PROMPT_VERSION,
        rowCount: preparedRows.length,
      })
      .returning({ id: aiSkuMatchRuns.id });
    return {
      candidates: [...providerCandidates.values()],
      kind: "RUN" as const,
      rows: preparedRows,
      runId: run.id,
      suggestionExpiresAt,
    };
  });
}

async function completeFailedRun(
  input: { actorUserId: string; customerId: string },
  runId: string,
  code: string,
  latencyMs: number,
  now: Date,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(aiSkuMatchRuns)
      .set({
        completedAt: now,
        latencyMs,
        safeErrorCode: code,
        status: "FAILED",
      })
      .where(
        and(eq(aiSkuMatchRuns.id, runId), eq(aiSkuMatchRuns.status, "PENDING")),
      );
    await tx.insert(auditLogs).values({
      action: "AI_SKU_MATCH_RUN_FAILED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: { safeErrorCode: code, status: "FAILED" },
      beforeJson: { status: "PENDING" },
      entityId: runId,
      entityType: "AI_SKU_MATCH_RUN",
      reason: "客户请求智能 SKU 推荐，供应商调用未完成",
    });
  });
}

export async function generateAiSkuMatchSuggestions(
  input: { actorUserId: string; batchId: string; customerId: string },
  options: { now?: Date; provider?: AiSkuMatchProvider } = {},
) {
  const config = readAiSkuMatchConfig();
  if (!config.enabled) {
    throw new AiSkuMatchError("UNAVAILABLE", "智能推荐服务暂未启用");
  }
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const prepared = await prepareGeneration(input, now, config.model);
  if (prepared.kind === "CACHED") {
    return { status: "CACHED" as const, suggestionCount: 0 };
  }
  const provider =
    options.provider ?? createDeepSeekSkuMatchProvider(config);
  const providerInput: AiSkuMatchProviderInput = {
    candidates: prepared.candidates,
    rows: prepared.rows.map((row) => ({
      candidateIds: row.candidateIds,
      externalSku: row.externalSku,
      productAttributes: row.productAttributes,
      productName: row.productName,
      rowId: row.rowId,
    })),
    userId: pseudonymousUserId(input.customerId),
  };
  let providerResult;
  try {
    providerResult = await provider.suggest(providerInput);
  } catch (error) {
    const safeCode =
      error instanceof AiSkuMatchProviderError ? error.code : "UPSTREAM";
    await completeFailedRun(
      input,
      prepared.runId,
      safeCode,
      Math.max(Date.now() - startedAt, 0),
      new Date(),
    );
    throw new AiSkuMatchError(
      "PROVIDER_FAILED",
      "智能推荐暂时不可用，您仍可继续手工填写 SKU",
    );
  }

  const completedAt = new Date();
  const latencyMs = Math.max(Date.now() - startedAt, 0);
  const outcome = await db.transaction(async (tx) => {
    const [scope] = await tx
      .select({
        aiSkuMatchEnabled: customers.aiSkuMatchEnabled,
        batchExpiresAt: orderImportBatches.expiresAt,
        batchStatus: orderImportBatches.status,
        customerStatus: customers.status,
      })
      .from(orderImportBatches)
      .innerJoin(customers, eq(customers.id, orderImportBatches.customerId))
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
        ),
      )
      .limit(1);
    if (
      !scope ||
      !scope.aiSkuMatchEnabled ||
      scope.customerStatus !== "ACTIVE" ||
      scope.batchStatus !== "PREVIEW" ||
      scope.batchExpiresAt <= completedAt
    ) {
      await tx
        .update(aiSkuMatchRuns)
        .set({
          completedAt,
          completionTokens: providerResult.completionTokens,
          latencyMs,
          promptTokens: providerResult.promptTokens,
          safeErrorCode: "SCOPE_CHANGED",
          status: "PARTIAL",
        })
        .where(
          and(
            eq(aiSkuMatchRuns.id, prepared.runId),
            eq(aiSkuMatchRuns.status, "PENDING"),
          ),
        );
      await tx.insert(auditLogs).values({
        action: "AI_SKU_MATCH_RUN_COMPLETED",
        actorId: input.actorUserId,
        actorType: "CUSTOMER",
        afterJson: {
          persistedRows: 0,
          promptVersion: PROMPT_VERSION,
          safeErrorCode: "SCOPE_CHANGED",
          status: "PARTIAL",
          suggestionCount: 0,
        },
        beforeJson: { status: "PENDING" },
        entityId: prepared.runId,
        entityType: "AI_SKU_MATCH_RUN",
        reason: "智能推荐返回时客户权限或预览状态已变化",
      });
      return { status: "PARTIAL" as const, suggestionCount: 0 };
    }
    const liveRows = await tx
      .select({
        effectiveQuantity: orderImportRows.effectiveQuantity,
        fulfillmentMode: orderImportRows.fulfillmentMode,
        id: orderImportRows.id,
        quantity: orderImportRows.quantity,
        revision: orderImportRows.revision,
        status: orderImportRows.status,
      })
      .from(orderImportRows)
      .where(
        and(
          eq(orderImportRows.batchId, input.batchId),
          inArray(
            orderImportRows.id,
            prepared.rows.map((row) => row.rowId),
          ),
        ),
      );
    const liveById = new Map(liveRows.map((row) => [row.id, row]));
    const candidateIds = [
      ...new Set(prepared.rows.flatMap((row) => row.candidateIds)),
    ];
    const currentCandidates = await loadCurrentCandidateStates(
      tx,
      input.batchId,
      candidateIds,
    );
    const currentById = new Map(
      currentCandidates.map((candidate) => [candidate.id, candidate]),
    );
    const preparedById = new Map(prepared.rows.map((row) => [row.rowId, row]));
    const matchedRowIds = new Set<string>();
    let suggestionCount = 0;
    let persistedRows = 0;
    for (const match of providerResult.matches) {
      const row = preparedById.get(match.rowId);
      const live = liveById.get(match.rowId);
      if (!row || matchedRowIds.has(match.rowId)) continue;
      matchedRowIds.add(match.rowId);
      if (
        !live ||
        live.revision !== row.revision ||
        live.status !== "UNKNOWN_SKU" ||
        live.fulfillmentMode !== "SYSTEM_SKU"
      ) {
        continue;
      }
      const allowed = new Set(row.candidateIds);
      const seen = new Set<string>();
      const candidates: AiSkuMatchCandidateSnapshot[] = [];
      for (const suggestion of match.suggestions) {
        const current = currentById.get(suggestion.candidateId);
        if (
          !allowed.has(suggestion.candidateId) ||
          seen.has(suggestion.candidateId) ||
          !current ||
          !baseCandidateAvailable(current) ||
          current.availableQuantity < row.effectiveQuantity
        ) {
          continue;
        }
        seen.add(suggestion.candidateId);
        candidates.push({
          confidence: suggestion.confidence,
          rank: candidates.length + 1,
          reason: suggestion.reason.slice(0, 120),
          skuId: suggestion.candidateId,
        });
        if (candidates.length === 3) break;
      }
      if (candidates.length === 0) continue;
      const [inserted] = await tx
        .insert(aiSkuMatchSuggestions)
        .values({
          batchId: input.batchId,
          candidates,
          customerId: input.customerId,
          expiresAt: prepared.suggestionExpiresAt,
          inputFingerprint: row.inputFingerprint,
          promptVersion: PROMPT_VERSION,
          rowId: row.rowId,
          rowRevision: row.revision,
          runId: prepared.runId,
        })
        .onConflictDoNothing()
        .returning({ id: aiSkuMatchSuggestions.id });
      if (!inserted) continue;
      persistedRows += 1;
      suggestionCount += candidates.length;
    }
    const allRowsCurrent = prepared.rows.every((row) => {
      const live = liveById.get(row.rowId);
      return (
        live?.revision === row.revision &&
        live.status === "UNKNOWN_SKU" &&
        live.fulfillmentMode === "SYSTEM_SKU"
      );
    });
    const status =
      allRowsCurrent && matchedRowIds.size === prepared.rows.length
        ? "SUCCEEDED"
        : "PARTIAL";
    await tx
      .update(aiSkuMatchRuns)
      .set({
        completedAt,
        completionTokens: providerResult.completionTokens,
        latencyMs,
        promptTokens: providerResult.promptTokens,
        status,
        suggestionCount,
      })
      .where(
        and(
          eq(aiSkuMatchRuns.id, prepared.runId),
          eq(aiSkuMatchRuns.status, "PENDING"),
        ),
      );
    await tx.insert(auditLogs).values({
      action: "AI_SKU_MATCH_RUN_COMPLETED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: {
        model: config.model,
        persistedRows,
        promptVersion: PROMPT_VERSION,
        status,
        suggestionCount,
      },
      beforeJson: { status: "PENDING" },
      entityId: prepared.runId,
      entityType: "AI_SKU_MATCH_RUN",
      reason: "客户主动请求智能 SKU 推荐",
    });
    return { status, suggestionCount };
  });
  return outcome;
}

export async function rejectAiSkuMatchSuggestion(input: {
  actorUserId: string;
  batchId: string;
  customerId: string;
  suggestionId: string;
}) {
  const outcome = await db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select({
        decision: aiSkuMatchSuggestions.decision,
        expiresAt: aiSkuMatchSuggestions.expiresAt,
        id: aiSkuMatchSuggestions.id,
        liveRevision: orderImportRows.revision,
        rowId: aiSkuMatchSuggestions.rowId,
        rowRevision: aiSkuMatchSuggestions.rowRevision,
      })
      .from(aiSkuMatchSuggestions)
      .innerJoin(
        orderImportRows,
        eq(orderImportRows.id, aiSkuMatchSuggestions.rowId),
      )
      .innerJoin(
        orderImportBatches,
        eq(orderImportBatches.id, aiSkuMatchSuggestions.batchId),
      )
      .where(
        and(
          eq(aiSkuMatchSuggestions.id, input.suggestionId),
          eq(aiSkuMatchSuggestions.customerId, input.customerId),
          eq(aiSkuMatchSuggestions.batchId, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
        ),
      )
      .for("update")
      .limit(1);
    if (!suggestion || suggestion.decision !== "PENDING") {
      throw new AiSkuMatchError(
        "SUGGESTION_NOT_FOUND",
        "找不到可处理的智能建议",
      );
    }
    const now = new Date();
    if (
      suggestion.expiresAt <= now ||
      suggestion.liveRevision !== suggestion.rowRevision
    ) {
      await tx
        .update(aiSkuMatchSuggestions)
        .set({ decision: "STALE", decidedAt: now })
        .where(eq(aiSkuMatchSuggestions.id, suggestion.id));
      return { kind: "STALE" as const };
    }
    await tx
      .update(aiSkuMatchSuggestions)
      .set({ decision: "REJECTED", decidedAt: now })
      .where(
        and(
          eq(aiSkuMatchSuggestions.id, suggestion.id),
          eq(aiSkuMatchSuggestions.decision, "PENDING"),
        ),
      );
    await tx.insert(auditLogs).values({
      action: "AI_SKU_MATCH_SUGGESTION_REJECTED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: { decision: "REJECTED" },
      beforeJson: { decision: "PENDING" },
      entityId: suggestion.id,
      entityType: "AI_SKU_MATCH_SUGGESTION",
      reason: "客户确认候选均不合适并继续手工匹配",
    });
    return { kind: "REJECTED" as const };
  });
  if (outcome.kind === "STALE") {
    throw new AiSkuMatchError(
      "SUGGESTION_STALE",
      "该智能建议已过期，请重新获取",
    );
  }
}

export async function deleteExpiredAiSkuMatchRecords(now = new Date()) {
  const deleted = await db
    .delete(aiSkuMatchRuns)
    .where(lte(aiSkuMatchRuns.expiresAt, now))
    .returning({ id: aiSkuMatchRuns.id });
  return deleted.length;
}
