import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  feishuCargoMigrationRuns,
} from "@/db/schema";
import {
  findLatestImportedCargoRefreshBaseline,
  getLatestCatalogFieldRefreshState,
} from "@/modules/feishu/queries";
import type { NormalizedCargoRow } from "@/modules/feishu/cargo-types";

const importedRow = {
  cargoUnitPriceMilliYuan: 99_000,
  color: null,
  combination: null,
  defaultUnitPriceFen: 9_900,
  defaultUnitPriceMilliYuan: 99_000,
  imageContentSha256: "a".repeat(64),
  imageTemporaryKey: "temporary/catalog/TZX-076.png",
  inheritedFrom: {},
  linkText: "TZX-076",
  productGroupKey: "76",
  productName: "审计占位商品",
  productUrl: "https://example.com/products/76",
  saleStatus: "SELLABLE",
  skuCode: "TZX-076",
  skuName: "审计占位商品",
  sourceRowNumber: 141,
  sourceSequence: "76",
  specification: null,
  totalQuantity: 0,
  weightGrams: null,
} satisfies NormalizedCargoRow;

async function seedImportedRun() {
  const [admin] = await db
    .insert(adminUsers)
    .values({ displayName: "Sync Admin", loginIdentifier: "sync-admin@example.com" })
    .returning({ id: adminUsers.id });

  await db.insert(feishuCargoMigrationRuns).values({
    confirmedByAdminUserId: admin.id,
    createdByAdminUserId: admin.id,
    importedAt: new Date("2026-08-19T03:04:00.000Z"),
    issuesJson: [],
    normalizedRowsJson: [importedRow],
    sourceDigest: "b".repeat(64),
    sourceRevision: 12,
    sourceSheetId: "trusted-source-sheet",
    sourceSpreadsheetHash: "c".repeat(64),
    status: "IMPORTED",
    summaryJson: {
      imageCount: 140,
      productCount: 76,
      skuCount: 140,
      sourceSequenceCount: 76,
      totalQuantity: 999,
    },
    updatedAt: new Date("2026-08-19T03:05:00.000Z"),
  });
}

afterEach(async () => {
  await db.execute(sql.raw(`
    truncate table audit_logs, feishu_cargo_migration_runs, admin_users
      restart identity cascade
  `));
});

describe("Feishu catalog refresh queries", () => {
  test("returns only server-trusted baseline data from the imported migration", async () => {
    await expect(findLatestImportedCargoRefreshBaseline()).resolves.toBeNull();
    await seedImportedRun();

    await expect(findLatestImportedCargoRefreshBaseline()).resolves.toEqual({
      cargoPricePlaceholders: [
        { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
      ],
      expectedSkuCount: 140,
      expectedSourceSequenceCount: 76,
      importedAtLabel: expect.any(String),
      sourceSheetId: "trusted-source-sheet",
      updatedAtLabel: expect.any(String),
    });
  });

  test("reports the latest successful field refresh without exposing audit details", async () => {
    await db.insert(auditLogs).values([
      {
        action: "CATALOG_FIELDS_REFRESHED_FROM_FEISHU",
        actorId: "admin-1",
        actorType: "ADMIN",
        afterJson: { internal: "must-not-leak" },
        beforeJson: {},
        createdAt: new Date("2026-08-20T01:00:00.000Z"),
        entityId: "feishu-catalog-fields",
        entityType: "CATALOG",
        reason: "first",
      },
      {
        action: "CATALOG_FIELDS_REFRESHED_FROM_FEISHU",
        actorId: "admin-2",
        actorType: "ADMIN",
        afterJson: { internal: "must-not-leak" },
        beforeJson: {},
        createdAt: new Date("2026-08-20T02:00:00.000Z"),
        entityId: "feishu-catalog-fields",
        entityType: "CATALOG",
        reason: "latest",
      },
    ]);

    const state = await getLatestCatalogFieldRefreshState();

    expect(state).toEqual({ lastUpdatedLabel: expect.any(String) });
    expect(Object.keys(state)).toEqual(["lastUpdatedLabel"]);
  });
});
