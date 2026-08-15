import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, products, skus } from "@/db/schema";

import { parseLegacyCargoSheet } from "./cargo-parser";
import type {
  AppliedCargoPricePlaceholder,
  CargoPricePlaceholder,
  ParsedCargoRow,
} from "./cargo-types";
import {
  readFeishuSourceSnapshot,
  type FeishuSourcePort,
} from "./source-reader";

export type CatalogFieldRefreshPreview = {
  cargoPricePlaceholders: AppliedCargoPricePlaceholder[];
  sourceSequenceCount: number;
  skuCount: number;
  matchedSkuCount: number;
  productsToMerge: number;
};

export type CatalogFieldRefreshReadPort = Pick<
  FeishuSourcePort,
  "resolveWikiSpreadsheet" | "listSheets" | "readRangeDetails"
>;

type DatabaseLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type PreparedSource = {
  appliedCargoPricePlaceholders: AppliedCargoPricePlaceholder[];
  rows: ParsedCargoRow[];
  sourceSequenceCount: number;
  skuCount: number;
};

type RefreshGroup = {
  canonicalProductId: string;
  rows: ParsedCargoRow[];
};

type RefreshPlan = CatalogFieldRefreshPreview & {
  groups: RefreshGroup[];
  involvedProductIds: string[];
};

function fail(code: string): never {
  throw new Error(code);
}

function assertExpectedCount(actual: number, expected: number, code: string) {
  if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected) {
    fail(code);
  }
}

async function prepareSource(input: {
  cargoPricePlaceholders?: readonly CargoPricePlaceholder[];
  client: CatalogFieldRefreshReadPort;
  expectedSkuCount: number;
  expectedSourceSequenceCount: number;
  sourceSheetId: string;
  sourceWikiToken: string;
}): Promise<PreparedSource> {
  const snapshot = await readFeishuSourceSnapshot({
    // The reader calls only the three read methods declared by this port.
    client: input.client as FeishuSourcePort,
    config: {
      sourceSheetId: input.sourceSheetId,
      sourceWikiToken: input.sourceWikiToken,
    },
  });
  if ("status" in snapshot) fail(snapshot.status);

  const parsed = parseLegacyCargoSheet(snapshot.values, {
    cargoPricePlaceholders: input.cargoPricePlaceholders,
  });
  if (parsed.issues.some((issue) => issue.severity === "BLOCKING")) {
    fail("PARSER_BLOCKING_ISSUES");
  }

  const sourceSequences = new Set(parsed.rows.map((row) => row.sourceSequence));
  const sourceSkuCodes = new Set(parsed.rows.map((row) => row.skuCode));
  if (sourceSequences.has("") || sourceSkuCodes.size !== parsed.rows.length) {
    fail("PARSER_BLOCKING_ISSUES");
  }
  assertExpectedCount(
    sourceSequences.size,
    input.expectedSourceSequenceCount,
    "SOURCE_SEQUENCE_COUNT_MISMATCH",
  );
  assertExpectedCount(sourceSkuCodes.size, input.expectedSkuCount, "SKU_COUNT_MISMATCH");

  return {
    appliedCargoPricePlaceholders: parsed.appliedCargoPricePlaceholders,
    rows: parsed.rows,
    skuCount: sourceSkuCodes.size,
    sourceSequenceCount: sourceSequences.size,
  };
}

function sameSkuSet(sourceSkuCodes: Set<string>, databaseSkuCodes: Set<string>) {
  return (
    sourceSkuCodes.size === databaseSkuCodes.size &&
    [...sourceSkuCodes].every((skuCode) => databaseSkuCodes.has(skuCode))
  );
}

async function buildRefreshPlan(
  database: DatabaseLike,
  source: PreparedSource,
): Promise<RefreshPlan> {
  const existingSkus = await database
    .select({ productId: skus.productId, skuCode: skus.skuCode })
    .from(skus);
  const sourceSkuCodes = new Set(source.rows.map((row) => row.skuCode));
  const databaseSkuCodes = new Set(existingSkus.map((row) => row.skuCode));
  if (!sameSkuSet(sourceSkuCodes, databaseSkuCodes)) fail("SKU_SET_MISMATCH");

  const productBySkuCode = new Map(
    existingSkus.map((row) => [row.skuCode, row.productId]),
  );
  const rowsBySequence = new Map<string, ParsedCargoRow[]>();
  for (const row of source.rows) {
    const group = rowsBySequence.get(row.sourceSequence) ?? [];
    group.push(row);
    rowsBySequence.set(row.sourceSequence, group);
  }

  const groups: RefreshGroup[] = [];
  const involvedProductIds = new Set<string>();
  let productsToMerge = 0;
  for (const [sourceSequence, rows] of rowsBySequence) {
    const skuCountByProductId = new Map<string, number>();
    for (const row of rows) {
      const productId = productBySkuCode.get(row.skuCode);
      if (!productId) fail("SKU_SET_MISMATCH");
      skuCountByProductId.set(productId, (skuCountByProductId.get(productId) ?? 0) + 1);
      involvedProductIds.add(productId);
    }
    const candidates = [...skuCountByProductId.entries()].sort(
      ([leftId, leftCount], [rightId, rightCount]) =>
        rightCount - leftCount || leftId.localeCompare(rightId),
    );
    const canonicalProductId = candidates[0]?.[0];
    if (!canonicalProductId) fail(`MISSING_PRODUCT_FOR_SOURCE_SEQUENCE:${sourceSequence}`);
    productsToMerge += candidates.length - 1;
    groups.push({ canonicalProductId, rows });
  }

  return {
    cargoPricePlaceholders: source.appliedCargoPricePlaceholders,
    groups,
    involvedProductIds: [...involvedProductIds],
    matchedSkuCount: existingSkus.length,
    productsToMerge,
    skuCount: source.skuCount,
    sourceSequenceCount: source.sourceSequenceCount,
  };
}

async function applyPlan(input: {
  actorUserId: string;
  database: Parameters<Parameters<typeof db.transaction>[0]>[0];
  plan: RefreshPlan;
  reason: string;
}) {
  if (input.plan.involvedProductIds.length > 0) {
    await input.database
      .update(products)
      .set({ sourceSequence: null, updatedAt: new Date() })
      .where(inArray(products.id, input.plan.involvedProductIds));
  }

  for (const group of input.plan.groups) {
    const parent = group.rows[0]!;
    await input.database
      .update(products)
      .set({
        cargoUnitPriceMilliYuan: parent.cargoUnitPriceMilliYuan,
        linkText: parent.linkText,
        name: parent.productName,
        sourceSequence: parent.sourceSequence,
        updatedAt: new Date(),
      })
      .where(eq(products.id, group.canonicalProductId));

    for (const row of group.rows) {
      await input.database
        .update(skus)
        .set({
          color: row.color,
          combination: row.combination,
          defaultUnitPriceFen: row.defaultUnitPriceFen,
          defaultUnitPriceMilliYuan: row.defaultUnitPriceMilliYuan,
          name: row.skuName,
          productId: group.canonicalProductId,
          productUrl: row.productUrl,
          saleStatus: row.saleStatus,
          specification: row.specification,
          updatedAt: new Date(),
          weightGrams: row.weightGrams,
        })
        .where(eq(skus.skuCode, row.skuCode));
    }
  }

  await input.database.insert(auditLogs).values({
    action: "CATALOG_FIELDS_REFRESHED_FROM_FEISHU",
    actorId: input.actorUserId,
    actorType: "ADMIN",
    afterJson: {
      cargoPricePlaceholders: input.plan.cargoPricePlaceholders,
      matchedSkuCount: input.plan.matchedSkuCount,
      productsToMerge: input.plan.productsToMerge,
      skuCount: input.plan.skuCount,
      sourceSequenceCount: input.plan.sourceSequenceCount,
    },
    beforeJson: {},
    entityId: "feishu-catalog-fields",
    entityType: "CATALOG",
    reason: input.reason,
  });
}

export function createCatalogFieldRefreshService(database: typeof db = db) {
  return {
    async preview(input: {
      cargoPricePlaceholders?: readonly CargoPricePlaceholder[];
      client: CatalogFieldRefreshReadPort;
      sourceSheetId: string;
      sourceWikiToken: string;
      expectedSourceSequenceCount: number;
      expectedSkuCount: number;
    }): Promise<CatalogFieldRefreshPreview> {
      const source = await prepareSource(input);
      const plan = await buildRefreshPlan(database, source);
      return {
        cargoPricePlaceholders: plan.cargoPricePlaceholders,
        matchedSkuCount: plan.matchedSkuCount,
        productsToMerge: plan.productsToMerge,
        skuCount: plan.skuCount,
        sourceSequenceCount: plan.sourceSequenceCount,
      };
    },
    async apply(input: {
      actorUserId: string;
      cargoPricePlaceholders?: readonly CargoPricePlaceholder[];
      client: CatalogFieldRefreshReadPort;
      reason: string;
      sourceSheetId: string;
      sourceWikiToken: string;
      expectedSourceSequenceCount: number;
      expectedSkuCount: number;
    }): Promise<CatalogFieldRefreshPreview> {
      const reason = input.reason.trim();
      if (!reason) fail("OPERATOR_REASON_REQUIRED");
      const source = await prepareSource(input);

      return await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext('feishu-catalog-field-refresh'))`,
        );
        const plan = await buildRefreshPlan(transaction, source);
        await applyPlan({
          actorUserId: input.actorUserId,
          database: transaction,
          plan,
          reason,
        });
        return {
          cargoPricePlaceholders: plan.cargoPricePlaceholders,
          matchedSkuCount: plan.matchedSkuCount,
          productsToMerge: plan.productsToMerge,
          skuCount: plan.skuCount,
          sourceSequenceCount: plan.sourceSequenceCount,
        };
      });
    },
  };
}
