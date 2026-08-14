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

async function expectConstraintFailure(
  operation: Promise<unknown>,
  input: { code: string; constraintName: string },
) {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({
      cause: expect.objectContaining({
        code: input.code,
        constraint_name: input.constraintName,
      }),
    });
    return;
  }

  throw new Error(`Expected constraint failure: ${input.constraintName}`);
}

async function insertMigrationRunUnchecked(input: {
  createdByAdminUserId: string;
  issuesJson: unknown;
  normalizedRowsJson: unknown;
  sourceDigest: string;
  sourceRevision: number;
  sourceSheetId: string;
  sourceSpreadsheetHash: string;
  status: string;
  summaryJson: unknown;
  temporaryAssetsJson: unknown;
}) {
  return db.execute(sql`
    insert into feishu_cargo_migration_runs (
      status,
      source_spreadsheet_hash,
      source_sheet_id,
      source_revision,
      source_digest,
      summary_json,
      normalized_rows_json,
      issues_json,
      temporary_assets_json,
      created_by_admin_user_id
    )
    values (
      ${input.status},
      ${input.sourceSpreadsheetHash},
      ${input.sourceSheetId},
      ${input.sourceRevision},
      ${input.sourceDigest},
      ${JSON.stringify(input.summaryJson)}::jsonb,
      ${JSON.stringify(input.normalizedRowsJson)}::jsonb,
      ${JSON.stringify(input.issuesJson)}::jsonb,
      ${JSON.stringify(input.temporaryAssetsJson)}::jsonb,
      ${input.createdByAdminUserId}::uuid
    )
  `);
}

async function getNormalizedRowsConstraintDefinition() {
  const rows = await db.execute(sql.raw(`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conname = 'feishu_cargo_migration_runs_normalized_rows_json_valid'
  `));

  return String(rows[0]?.definition ?? "");
}

function validNormalizedRow() {
  return {
    color: null,
    combination: null,
    defaultUnitPriceFen: 299,
    defaultUnitPriceMilliYuan: 2_990,
    imageContentSha256: "1".repeat(64),
    imageTemporaryKey: "temp-assets/tzx-001.png",
    inheritedFrom: {},
    linkText: "Cargo Product",
    productGroupKey: "group-1",
    productName: "Cargo Product",
    productUrl: "https://example.test/products/tzx-001",
    saleStatus: "SELLABLE" as const,
    skuCode: "TZX-001",
    skuName: "Cargo SKU",
    sourceRowNumber: 1,
    specification: null,
    totalQuantity: 1,
    weightGrams: 1200,
  };
}

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
        issuesJson: [],
        normalizedRowsJson: [
          {
            color: null,
            combination: null,
            defaultUnitPriceFen: 299,
            defaultUnitPriceMilliYuan: 2_990,
            imageContentSha256: "1".repeat(64),
            imageTemporaryKey: "temp-assets/tzx-001.png",
            inheritedFrom: { image: 1, productName: 1, weight: 1 },
            linkText: "Cargo Product",
            productGroupKey: "group-1",
            productName: "Cargo Product",
            productUrl: "https://example.test/products/tzx-001",
            saleStatus: "SELLABLE",
            skuCode: "TZX-001",
            skuName: "Cargo SKU",
            sourceRowNumber: 1,
            specification: null,
            totalQuantity: 148,
            weightGrams: 1200,
          },
        ],
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
        temporaryAssetsJson: [
          {
            byteSize: 1024,
            contentSha256: "2".repeat(64),
            mimeType: "image/png",
            originalFileName: "TZX-001.png",
            skuCode: "TZX-001",
            temporaryKey: "temp-assets/tzx-001.png",
          },
        ],
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
        defaultUnitPriceMilliYuan: 2_990,
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
        issuesJson: [
          {
            code: "WARN_DUPLICATE_IMAGE",
            message: "duplicate image reused",
            severity: "WARNING",
            sourceRowNumber: 1,
          },
        ],
        normalizedRowsJson: [
          {
            color: null,
            combination: null,
            defaultUnitPriceFen: 299,
            defaultUnitPriceMilliYuan: 2_990,
            imageContentSha256: "3".repeat(64),
            imageTemporaryKey: "temp-assets/tzx-001-v2.png",
            inheritedFrom: { image: 2 },
            linkText: "Cargo Product",
            productGroupKey: "group-1",
            productName: "Cargo Product",
            productUrl: "https://example.test/products/tzx-001",
            saleStatus: "SELLABLE",
            skuCode: "TZX-001",
            skuName: "Cargo SKU",
            sourceRowNumber: 2,
            specification: "Standard",
            totalQuantity: 10,
            weightGrams: 1200,
          },
        ],
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
        temporaryAssetsJson: [
          {
            byteSize: 1024,
            contentSha256: "4".repeat(64),
            mimeType: "image/png",
            originalFileName: "TZX-001-v2.png",
            skuCode: "TZX-001",
            temporaryKey: "temp-assets/tzx-001-v2.png",
          },
        ],
      })
      .returning();

    expect(run.status).toBe("PREFLIGHT_READY");
    expect(importedRun.status).toBe("IMPORTED");
    expect(sku.imageAssetId).toBe(asset.id);
    expect(sku.imageUrl).toBe("https://example.test/legacy-image.png");

    await expectConstraintFailure(
      db.insert(feishuCargoMigrationRuns).values({
        confirmedByAdminUserId: admin.id,
        createdByAdminUserId: admin.id,
        importedAt: new Date("2026-08-13T09:00:00.000Z"),
        issuesJson: [],
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
        temporaryAssetsJson: [],
      }),
      {
        code: "23505",
        constraintName: "feishu_cargo_migration_runs_imported_once",
      },
    );
  });

  test("rejects invalid sha256 digests and negative asset byte sizes with named constraints", async () => {
    await expectConstraintFailure(
      db.insert(catalogAssets).values({
        byteSize: 1024,
        contentSha256: "not-a-sha",
        mimeType: "image/png",
        originalFileName: "bad-sha.png",
        storageKey: "sha256/bad/bad-sha.png",
      }),
      {
        code: "23514",
        constraintName: "catalog_assets_content_sha256_format",
      },
    );

    await expectConstraintFailure(
      db.insert(catalogAssets).values({
        byteSize: -1,
        contentSha256: "9".repeat(64),
        mimeType: "image/webp",
        originalFileName: "negative-size.webp",
        storageKey: "sha256/99/negative-size.webp",
      }),
      {
        code: "23514",
        constraintName: "catalog_assets_byte_size_non_negative",
      },
    );
  });

  test("rejects invalid migration json payloads with named constraints", async () => {
    const [admin] = await db
      .insert(adminUsers)
      .values({
        displayName: "JSON Constraint Admin",
        loginIdentifier: "json-constraint-admin@test.local",
      })
      .returning();

    const baseValues = {
      createdByAdminUserId: admin.id,
      sourceDigest: "a".repeat(64),
      sourceRevision: 12,
      sourceSheetId: "cargo-sheet",
      sourceSpreadsheetHash: "b".repeat(64),
      status: "PREFLIGHT_READY" as const,
    };

    await expectConstraintFailure(
      insertMigrationRunUnchecked({
        ...baseValues,
        issuesJson: [],
        normalizedRowsJson: [],
        summaryJson: {
          imageCount: 1,
          productCount: 1,
          skuCount: 1,
          totalQuantity: -1,
        },
        temporaryAssetsJson: [],
      }),
      {
        code: "23514",
        constraintName: "feishu_cargo_migration_runs_summary_json_valid",
      },
    );

    await expectConstraintFailure(
      insertMigrationRunUnchecked({
        ...baseValues,
        issuesJson: [],
        normalizedRowsJson: [
          {
            color: null,
            combination: null,
            defaultUnitPriceFen: 299.5,
            defaultUnitPriceMilliYuan: 2_990,
            fileToken: "should-not-persist",
            imageContentSha256: "1".repeat(64),
            imageTemporaryKey: "temp-assets/tzx-001.png",
            inheritedFrom: {},
            linkText: "Cargo Product",
            productGroupKey: "group-1",
            productName: "Cargo Product",
            productUrl: "https://example.test/products/tzx-001",
            saleStatus: "PENDING",
            skuCode: "TZX-001",
            skuName: "Cargo SKU",
            sourceRowNumber: 0,
            specification: null,
            totalQuantity: -1,
            weightGrams: -2,
          },
        ],
        summaryJson: {
          imageCount: 1,
          productCount: 1,
          skuCount: 1,
          totalQuantity: 1,
        },
        temporaryAssetsJson: [],
      }),
      {
        code: "23514",
        constraintName: "feishu_cargo_migration_runs_normalized_rows_json_valid",
      },
    );

    await expectConstraintFailure(
      insertMigrationRunUnchecked({
        ...baseValues,
        issuesJson: [],
        normalizedRowsJson: [],
        summaryJson: {
          imageCount: 1,
          productCount: 1,
          skuCount: 1,
          totalQuantity: 1,
        },
        temporaryAssetsJson: [
          {
            byteSize: -1,
            contentSha256: "not-a-sha",
            mimeType: "image/gif",
            originalFileName: "bad.gif",
            skuCode: "TZX-001",
            temporaryKey: "temp-assets/bad.gif",
          },
        ],
      }),
      {
        code: "23514",
        constraintName: "feishu_cargo_migration_runs_temporary_assets_json_valid",
      },
    );

    await expectConstraintFailure(
      insertMigrationRunUnchecked({
        ...baseValues,
        issuesJson: [
          {
            code: "BAD",
            message: "bad issue payload",
            severity: "INFO",
            sourceRowNumber: 0,
          },
        ],
        normalizedRowsJson: [],
        summaryJson: {
          imageCount: 1,
          productCount: 1,
          skuCount: 1,
          totalQuantity: 1,
        },
        temporaryAssetsJson: [],
      }),
      {
        code: "23514",
        constraintName: "feishu_cargo_migration_runs_issues_json_valid",
      },
    );
  });

  test("rejects normalized rows that persist file tokens under either legacy or ephemeral keys", async () => {
    const constraintDefinition = await getNormalizedRowsConstraintDefinition();
    expect(constraintDefinition).toContain('exists (@.**."fileToken")');
    expect(constraintDefinition).toContain('exists (@.**."imageFileToken")');

    const [admin] = await db
      .insert(adminUsers)
      .values({
        displayName: "Forbidden Token Admin",
        loginIdentifier: "forbidden-token-admin@test.local",
      })
      .returning();

    const baseValues = {
      createdByAdminUserId: admin.id,
      sourceDigest: "c".repeat(64),
      sourceRevision: 99,
      sourceSheetId: "cargo-sheet",
      sourceSpreadsheetHash: "d".repeat(64),
      status: "PREFLIGHT_READY" as const,
      summaryJson: {
        imageCount: 1,
        productCount: 1,
        skuCount: 1,
        totalQuantity: 1,
      },
      temporaryAssetsJson: [],
    };

    await expectConstraintFailure(
      insertMigrationRunUnchecked({
        ...baseValues,
        issuesJson: [],
        normalizedRowsJson: [
          {
            ...validNormalizedRow(),
            imageFileToken: "should-not-persist",
          },
        ],
      }),
      {
        code: "23514",
        constraintName: "feishu_cargo_migration_runs_normalized_rows_json_valid",
      },
    );

    await expectConstraintFailure(
      insertMigrationRunUnchecked({
        ...baseValues,
        issuesJson: [],
        normalizedRowsJson: [
          {
            ...validNormalizedRow(),
            nested: {
              fileToken: "still-forbidden",
            },
          },
        ],
      }),
      {
        code: "23514",
        constraintName: "feishu_cargo_migration_runs_normalized_rows_json_valid",
      },
    );
  });
});
