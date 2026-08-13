import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import { FeishuApiError } from "@/integrations/feishu/client";
import type { FeishuIntegrationConfig } from "@/integrations/feishu/config";
import {
  adminUsers,
  auditLogs,
  authUsers,
  catalogAssets,
  feishuCargoMigrationRuns,
  integrationOutbox,
  inventoryBalances,
  inventoryMovements,
  products,
  skus,
} from "@/db/schema";
import {
  createFeishuCargoMigrationService,
  FeishuCargoMigrationError,
} from "@/modules/feishu/migration-service";
import type {
  FeishuSourcePort,
  FeishuSourceSelectionRequired,
} from "@/modules/feishu/source-reader";

const HEADER_ROW = [
  "\u5e8f\u53f7",
  "sku",
  "\u56fe\u7247",
  "\u540d\u79f0",
  "\u91c7\u8d2d\u4ef7",
  "\u603b\u5e93\u5b58",
  "\u72b6\u6001",
  "\u94fe\u63a5\u6587\u5b57",
  "\u89c4\u683c",
  "\u989c\u8272",
  "\u7ec4\u5408\u9500\u552e",
  "\u91cd\u91cf",
] as const;

type DownloadRecord = {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
};

type SourceDataset = {
  downloads: Map<string, DownloadRecord>;
  values: unknown[][];
};

function createConfig(input?: Partial<FeishuIntegrationConfig>): FeishuIntegrationConfig {
  return {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    sourceSheetId: "sheet-primary",
    sourceWikiToken: "wiki-source-token",
    targetSheetId: "target-sheet",
    targetSpreadsheetToken: "target-spreadsheet-token",
    ...input,
  };
}

function expectPreflightReady(
  result:
    | FeishuSourceSelectionRequired
    | { runId: string; status: "PREFLIGHT_BLOCKED" | "PREFLIGHT_READY" },
) {
  if ("runId" in result) {
    return result;
  }
  throw new Error(`Expected a persisted preflight run, got ${result.status}`);
}

async function createImageBuffer(seed: number) {
  return await sharp({
    create: {
      background: {
        alpha: 1,
        b: (seed * 41) % 255,
        g: (seed * 23) % 255,
        r: (seed * 11) % 255,
      },
      channels: 4,
      height: 12,
      width: 12,
    },
  })
    .png()
    .toBuffer();
}

function buildRow(input: {
  color: string;
  combination: string;
  groupKey: string;
  priceYuan: string;
  productName: string;
  productUrl: string;
  quantity: number;
  skuCode: string;
  specification: string;
  status?: "SELLABLE" | "NOT_SELLABLE";
  weight: string;
}) {
  return [
    input.groupKey,
    input.skuCode,
    {
      fileToken: `file-token-${input.skuCode}`,
      text: `Image ${input.skuCode}`,
    },
    input.productName,
    input.priceYuan,
    String(input.quantity),
    input.status === "NOT_SELLABLE" ? "\u4e0d\u53ef\u552e" : "\u53ef\u552e",
    input.productUrl,
    input.specification,
    input.color,
    input.combination,
    input.weight,
  ];
}

async function buildValidSourceDataset(input?: { firstProductName?: string; rowCount?: number }) {
  const rowCount = input?.rowCount ?? 74;
  const downloads = new Map<string, DownloadRecord>();
  const values: unknown[][] = [Array.from(HEADER_ROW)];

  for (let index = 1; index <= rowCount; index += 1) {
    const groupNumber = index <= 50 ? index : index - 50;
    const skuCode = `SKU-${String(index).padStart(3, "0")}`;
    values.push(
      buildRow({
        color: `Color ${index}`,
        combination: `Combo ${index}`,
        groupKey: `GROUP-${String(groupNumber).padStart(3, "0")}`,
        priceYuan: `${10 + index}.50`,
        productName:
          index === 1 && input?.firstProductName
            ? input.firstProductName
            : `Product ${groupNumber}`,
        productUrl: `https://example.test/products/${groupNumber}`,
        quantity: index % 6 === 0 ? 0 : (index % 9) + 1,
        skuCode,
        specification: `Spec ${index}`,
        weight: `${100 + index}g`,
      }),
    );
    downloads.set(`file-token-${skuCode}`, {
      bytes: await createImageBuffer(index),
      contentType: "image/png",
      fileName: `${skuCode}.png`,
    });
  }

  return { downloads, values };
}

function cloneDataset(input: SourceDataset): SourceDataset {
  return {
    downloads: new Map(input.downloads),
    values: input.values.map((row) =>
      Array.isArray(row) ? structuredClone(row) : row,
    ) as unknown[][],
  };
}

async function createSuperAdminActor() {
  const userId = crypto.randomUUID();
  const email = `super-admin-${userId}@example.test`;

  await db.insert(authUsers).values({
    banned: false,
    email,
    id: userId,
    name: "Migration Super Admin",
    role: "super_admin",
  });
  await db.execute(sql`
    insert into admin_users (id, login_identifier, display_name, status)
    values (${crypto.randomUUID()}::uuid, ${email}, 'Migration Mirror', 'ACTIVE')
  `);

  return { kind: "SUPER_ADMIN" as const, userId };
}

async function createOrdinaryAdminActor() {
  const userId = crypto.randomUUID();
  const email = `admin-${userId}@example.test`;

  await db.insert(authUsers).values({
    banned: false,
    email,
    id: userId,
    name: "Ordinary Admin",
    role: "admin",
  });
  await db.execute(sql`
    insert into admin_users (id, login_identifier, display_name, status)
    values (${crypto.randomUUID()}::uuid, ${email}, 'Ordinary Admin Mirror', 'ACTIVE')
  `);

  return { kind: "ADMIN" as const, userId };
}

function createMutableSourceClient(input: {
  initialDataset: SourceDataset;
  revision?: number;
  spreadsheetToken?: string;
}) {
  const state = {
    dataset: cloneDataset(input.initialDataset),
    revision: input.revision ?? 11,
    spreadsheetToken: input.spreadsheetToken ?? "source-spreadsheet-token",
  };
  const calls = {
    downloadMedia: [] as string[],
    listSheets: 0,
    readRangeDetails: [] as Array<{ range: string; spreadsheetToken: string }>,
    resolveWikiSpreadsheet: 0,
  };

  const client: FeishuSourcePort = {
    async downloadMedia(fileToken: string) {
      calls.downloadMedia.push(fileToken);
      const record = state.dataset.downloads.get(fileToken);
      if (!record) {
        throw new FeishuApiError("HTTP_404", "missing media", false);
      }
      return record;
    },
    async listSheets() {
      calls.listSheets += 1;
      return [{ index: 0, sheetId: "sheet-primary", title: "Primary source sheet" }];
    },
    async readRangeDetails(readInput) {
      calls.readRangeDetails.push(readInput);
      return {
        range: readInput.range,
        revision: state.revision,
        values: state.dataset.values,
      };
    },
    async resolveWikiSpreadsheet() {
      calls.resolveWikiSpreadsheet += 1;
      return { spreadsheetToken: state.spreadsheetToken };
    },
  };

  return {
    calls,
    client,
    setDataset(nextDataset: SourceDataset) {
      state.dataset = cloneDataset(nextDataset);
    },
    setDownloadRecord(fileToken: string, record: DownloadRecord) {
      state.dataset.downloads.set(fileToken, record);
    },
    setDownloadFailure(fileToken: string, error: Error) {
      state.dataset.downloads.set(fileToken, {
        bytes: new Uint8Array(),
        contentType: "application/x-error",
        fileName: `${fileToken}.error`,
      });
      client.downloadMedia = async (token: string) => {
        calls.downloadMedia.push(token);
        if (token === fileToken) {
          throw error;
        }
        const record = state.dataset.downloads.get(token);
        if (!record || record.contentType === "application/x-error") {
          throw new FeishuApiError("HTTP_404", "missing media", false);
        }
        return record;
      };
    },
    setRevision(nextRevision: number) {
      state.revision = nextRevision;
    },
    state,
  };
}

async function listFilesRecursively(root: string) {
  const output: string[] = [];

  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        output.push(absolutePath);
      }
    }
  }

  await walk(root);
  return output.sort();
}

describe("Feishu cargo migration service", () => {
  let assetRoot = "";
  let baseDataset: SourceDataset;

  beforeEach(async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "feishu-migration-service-"));
    baseDataset = await buildValidSourceDataset();
    process.env.FEISHU_APP_ID = "test-app-id";
    process.env.FEISHU_APP_SECRET = "test-app-secret";
    process.env.FEISHU_CARGO_SOURCE_WIKI_TOKEN = "wiki-source-token";
    process.env.FEISHU_CARGO_SOURCE_SHEET_ID = "sheet-primary";
    process.env.FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN = "target-spreadsheet-token";
    process.env.FEISHU_CARGO_TARGET_SHEET_ID = "target-sheet";
  });

  afterEach(async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_CARGO_SOURCE_WIKI_TOKEN;
    delete process.env.FEISHU_CARGO_SOURCE_SHEET_ID;
    delete process.env.FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN;
    delete process.env.FEISHU_CARGO_TARGET_SHEET_ID;

    await db.execute(sql.raw(`
      truncate table
        feishu_cargo_migration_runs,
        integration_attempts,
        integration_outbox,
        audit_logs,
        inventory_movements,
        inventory_reservations,
        inventory_balances,
        catalog_assets,
        sku_aliases,
        customer_sku_prices,
        auth_sessions,
        auth_accounts,
        auth_verifications,
        auth_users,
        customer_users,
        admin_users,
        skus,
        products,
        customers
      restart identity cascade
    `));
    await rm(assetRoot, { force: true, recursive: true });
  });

  test("preflights 74 valid rows into a ready run with staged assets and no catalog writes", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const result = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    expect(result).toEqual({
      runId: expect.any(String),
      status: "PREFLIGHT_READY",
    });

    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, result.runId))
      .limit(1);

    expect(run).toMatchObject({
      sourceDigest: createHash("sha256")
        .update(JSON.stringify(run?.normalizedRowsJson))
        .digest("hex"),
      sourceRevision: 11,
      sourceSheetId: "sheet-primary",
      sourceSpreadsheetHash: createHash("sha256")
        .update("source-spreadsheet-token")
        .digest("hex"),
      status: "PREFLIGHT_READY",
    });
    expect(run?.summaryJson).toMatchObject({
      imageCount: 74,
      productCount: 50,
      skuCount: 74,
    });
    expect(run?.temporaryAssetsJson).toHaveLength(74);
    expect(await db.select().from(products)).toEqual([]);
    expect(await db.select().from(skus)).toEqual([]);
  });

  test("blocks preflight when parser emits a blocking issue and leaves staged assets empty", async () => {
    const actor = await createSuperAdminActor();
    const blockedDataset = cloneDataset(baseDataset);
    blockedDataset.values[2][6] = "";
    const fakeSource = createMutableSourceClient({ initialDataset: blockedDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const result = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    expect(result.status).toBe("PREFLIGHT_BLOCKED");
    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, result.runId))
      .limit(1);
    expect(run?.status).toBe("PREFLIGHT_BLOCKED");
    expect(run?.temporaryAssetsJson).toEqual([]);
    expect(run?.issuesJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CARGO_MISSING_SALE_STATUS", severity: "BLOCKING" }),
      ]),
    );

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: result.runId,
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_NOT_CONFIRMABLE" satisfies FeishuCargoMigrationError["code"] });
  });

  test("sanitizes permanent source image download failures as blocking preflight issues", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    fakeSource.setDownloadFailure(
      "file-token-SKU-001",
      new FeishuApiError(
        "HTTP_403",
        "https://open.feishu.cn/open-apis/drive/v1/medias/file-token-SKU-001/download",
        false,
      ),
    );
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const result = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    expect(result.status).toBe("PREFLIGHT_BLOCKED");
    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, result.runId))
      .limit(1);
    expect(run?.issuesJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_IMAGE_DOWNLOAD_FAILED",
          severity: "BLOCKING",
          sourceRowNumber: 2,
        }),
      ]),
    );
    expect(JSON.stringify(run?.issuesJson)).not.toContain("file-token-SKU-001");
    expect(await listFilesRecursively(assetRoot)).toEqual([]);
  });

  test("marks retryable source image failures as blocked preflight issues", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    fakeSource.setDownloadFailure(
      "file-token-SKU-001",
      new FeishuApiError("HTTP_500", "upstream outage", true),
    );
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const result = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    expect(result.status).toBe("PREFLIGHT_BLOCKED");
    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, result.runId))
      .limit(1);
    expect(run?.issuesJson).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_IMAGE_DOWNLOAD_FAILED",
          severity: "RETRYABLE",
        }),
      ]),
    );
  });

  test("rejects preflight and confirmation for non-super-admin actors", async () => {
    const ordinaryAdmin = await createOrdinaryAdminActor();
    const superAdmin = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    await expect(
      service.createCargoPreflight({
        actor: ordinaryAdmin,
        client: fakeSource.client,
        config: createConfig(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" satisfies FeishuCargoMigrationError["code"] });

    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor: superAdmin,
      client: fakeSource.client,
      config: createConfig(),
    }));

    await expect(
      service.confirmCargoMigration({
        actor: ordinaryAdmin,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" satisfies FeishuCargoMigrationError["code"] });
  });

  test("marks a preflight run stale when the source revision changes before confirmation", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    fakeSource.setRevision(12);

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_STALE" satisfies FeishuCargoMigrationError["code"] });

    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, readyRun.runId))
      .limit(1);
    expect(run?.status).toBe("STALE");
  });

  test("marks a preflight run stale when the canonical row digest changes", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    const changedDataset = cloneDataset(baseDataset);
    changedDataset.values[1][3] = "Changed product name";
    fakeSource.setDataset(changedDataset);

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_STALE" satisfies FeishuCargoMigrationError["code"] });
  });

  test("blocks confirmation when catalog SKUs already exist", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    const [product] = await db.insert(products).values({ name: "Existing product" }).returning();
    await db.insert(skus).values({
      defaultUnitPriceFen: 100,
      name: "Existing sku",
      productId: product.id,
      skuCode: "EXISTING-SKU",
    });

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_NOT_EMPTY" satisfies FeishuCargoMigrationError["code"] });
  });

  test("blocks confirmation when another imported migration run already exists", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    const [mirrorAdmin] = await db.select().from(adminUsers).limit(1);
    await db.insert(feishuCargoMigrationRuns).values({
      confirmedByAdminUserId: mirrorAdmin.id,
      createdByAdminUserId: mirrorAdmin.id,
      importedAt: new Date("2026-08-13T10:00:00.000Z"),
      issuesJson: [],
      normalizedRowsJson: [],
      sourceDigest: "f".repeat(64),
      sourceRevision: 15,
      sourceSheetId: "sheet-primary",
      sourceSpreadsheetHash: "e".repeat(64),
      status: "IMPORTED",
      summaryJson: {
        imageCount: 0,
        productCount: 0,
        skuCount: 0,
        totalQuantity: 0,
      },
      temporaryAssetsJson: [],
    });

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_IMPORTED" satisfies FeishuCargoMigrationError["code"] });
  });

  test("rolls back database writes and cleans newly published files when confirmation fails inside the transaction", async () => {
    const actor = await createSuperAdminActor();
    const failingDataset = await buildValidSourceDataset({
      firstProductName: "X".repeat(260),
    });
    const fakeSource = createMutableSourceClient({ initialDataset: failingDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toThrow();

    expect(await db.select().from(products)).toEqual([]);
    expect(await db.select().from(skus)).toEqual([]);
    expect(await db.select().from(inventoryBalances)).toEqual([]);
    expect(await db.select().from(inventoryMovements)).toEqual([]);
    expect(await db.select().from(catalogAssets)).toEqual([]);
    expect(await listFilesRecursively(join(assetRoot, "sha256"))).toEqual([]);
  });

  test("imports products, skus, assets, balances, movements, audit and one outbox sync exactly once", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    const result = await service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig(),
      runId: readyRun.runId,
    });

    const importedProducts = await db.select().from(products);
    const importedSkus = await db.select().from(skus);
    const importedAssets = await db.select().from(catalogAssets);
    const balances = await db.select().from(inventoryBalances);
    const movements = await db.select().from(inventoryMovements);
    const [run] = await db
      .select()
      .from(feishuCargoMigrationRuns)
      .where(eq(feishuCargoMigrationRuns.id, readyRun.runId))
      .limit(1);

    expect(result).toEqual({ imageCount: 74, productCount: 50, skuCount: 74 });
    expect(run?.status).toBe("IMPORTED");
    expect(importedProducts).toHaveLength(50);
    expect(importedSkus).toHaveLength(74);
    expect(importedAssets).toHaveLength(74);
    expect(balances).toHaveLength(74);
    expect(movements).toHaveLength(
      baseDataset.values.slice(1).filter((row) => Number.parseInt(String(row[5]), 10) > 0).length,
    );
    expect(importedSkus[0]).toMatchObject({
      imageUrl: `/api/catalog-assets/${importedSkus[0].imageAssetId}`,
      name: "Spec 1 / Color 1 / Combo 1",
    });
    expect(await db.select().from(auditLogs)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "FEISHU_CARGO_IMPORTED",
          actorId: actor.userId,
          entityId: readyRun.runId,
        }),
      ]),
    );
    expect(await db.select().from(integrationOutbox)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateId: "cargo-sheet",
          eventType: "FEISHU_CARGO_SYNC",
          target: "FEISHU_SHEET",
        }),
      ]),
    );

    const firstAsset = importedAssets[0];
    expect(firstAsset.storageKey).toMatch(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(await listFilesRecursively(join(assetRoot, dirname(firstAsset.storageKey)))).toEqual(
      expect.arrayContaining([join(assetRoot, firstAsset.storageKey)]),
    );
  });

  test("two concurrent confirm calls produce exactly one import and one deterministic conflict", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    const settled = await Promise.allSettled([
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        code: "ALREADY_IMPORTED",
      }),
    });
    expect(await db.select().from(products)).toHaveLength(50);
    expect(await db.select().from(skus)).toHaveLength(74);
    expect(await db.select().from(catalogAssets)).toHaveLength(74);
  });
});
