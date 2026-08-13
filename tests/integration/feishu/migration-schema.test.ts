import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  catalogAssets,
  feishuCargoMigrationRuns,
  products,
  skus,
} from "@/db/schema";

describe("Feishu cargo migration schema", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        feishu_cargo_migration_runs,
        catalog_assets,
        admin_users,
        skus,
        products
      restart identity cascade
    `));
  });

  test("persists one imported migration run and lets a sku reference one current image asset", async () => {
    const [admin] = await db
      .insert(adminUsers)
      .values({
        displayName: "Cargo Admin",
        loginIdentifier: "cargo-admin@test.local",
      })
      .returning();

    const [run] = await db
      .insert(feishuCargoMigrationRuns)
      .values({
        createdByAdminUserId: admin.id,
        normalizedRowsJson: [],
        sourceDigest: "a".repeat(64),
        sourceRevision: 12,
        sourceSheetId: "cargo-sheet",
        sourceSpreadsheetHash: "b".repeat(64),
        status: "PREFLIGHT_READY",
        summaryJson: {
          imageCount: 74,
          productCount: 50,
          skuCount: 74,
          totalQuantity: 148,
        },
      })
      .returning();

    const [asset] = await db
      .insert(catalogAssets)
      .values({
        byteSize: 1024,
        contentSha256: "c".repeat(64),
        mimeType: "image/png",
        originalFileName: "TZX-001.png",
        storageKey: "sha256/cc/example.png",
      })
      .returning();

    const [product] = await db
      .insert(products)
      .values({ name: "Cargo Product" })
      .returning();

    const [sku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: 299,
        imageAssetId: asset.id,
        imageUrl: "https://example.test/legacy-image.png",
        name: "Cargo SKU",
        productId: product.id,
        skuCode: "TZX-001",
      })
      .returning();

    const [importedRun] = await db
      .insert(feishuCargoMigrationRuns)
      .values({
        confirmedByAdminUserId: admin.id,
        createdByAdminUserId: admin.id,
        importedAt: new Date("2026-08-13T08:00:00.000Z"),
        normalizedRowsJson: [],
        sourceDigest: "d".repeat(64),
        sourceRevision: 13,
        sourceSheetId: "cargo-sheet",
        sourceSpreadsheetHash: "e".repeat(64),
        status: "IMPORTED",
        summaryJson: {
          imageCount: 1,
          productCount: 1,
          skuCount: 1,
          totalQuantity: 10,
        },
      })
      .returning();

    expect(run.status).toBe("PREFLIGHT_READY");
    expect(importedRun.status).toBe("IMPORTED");
    expect(sku.imageAssetId).toBe(asset.id);
    expect(sku.imageUrl).toBe("https://example.test/legacy-image.png");

    await expect(
      db.insert(feishuCargoMigrationRuns).values({
        confirmedByAdminUserId: admin.id,
        createdByAdminUserId: admin.id,
        importedAt: new Date("2026-08-13T09:00:00.000Z"),
        normalizedRowsJson: [],
        sourceDigest: "f".repeat(64),
        sourceRevision: 14,
        sourceSheetId: "cargo-sheet",
        sourceSpreadsheetHash: "1".repeat(64),
        status: "IMPORTED",
        summaryJson: {
          imageCount: 2,
          productCount: 2,
          skuCount: 2,
          totalQuantity: 20,
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects invalid sha256 digests and negative asset byte sizes", async () => {
    await expect(
      db.insert(catalogAssets).values({
        byteSize: 1024,
        contentSha256: "not-a-sha",
        mimeType: "image/png",
        originalFileName: "bad-sha.png",
        storageKey: "sha256/bad/bad-sha.png",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(catalogAssets).values({
        byteSize: -1,
        contentSha256: "9".repeat(64),
        mimeType: "image/webp",
        originalFileName: "negative-size.webp",
        storageKey: "sha256/99/negative-size.webp",
      }),
    ).rejects.toThrow();
  });
});
