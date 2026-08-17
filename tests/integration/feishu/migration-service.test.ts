import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
  customers,
  customerSkuPrices,
  feishuCargoMigrationRuns,
  integrationOutbox,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import {
  createFeishuCargoMigrationService,
  FeishuCargoMigrationError,
} from "@/modules/feishu/migration-service";
import { createCatalogAssetStorage } from "@/modules/feishu/asset-storage";
import type {
  FeishuSourcePort,
  FeishuSourceSelectionRequired,
} from "@/modules/feishu/source-reader";
import type { SuperAdminPrincipal } from "@/modules/identity/principal";
import { buildFieldAlignedCargoSourceFixture } from "../../fixtures/feishu/field-aligned-cargo-source";

const HEADER_ROW = [
  "\u5e8f\u53f7",
  "sku",
  "\u56fe\u7247",
  "\u540d\u79f0",
  "\u8d27\u54c1\u4ef7\u683c",
  "\u91c7\u8d2d\u4ef7",
  "\u603b\u5e93\u5b58",
  "\u53ef\u552e\u5e93\u5b58",
  "\u94fe\u63a5\u6587\u5b57",
  "\u89c4\u683c",
  "\u989c\u8272",
  "\u7ec4\u5408\u9500\u552e",
  "\u91cd\u91cf",
  "\u72b6\u6001",
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
    cargoImportEnabled: true,
    cargoWritesEnabled: false,
    sourceSheetId: "sheet-primary",
    sourceWikiToken: "wiki-source-token",
    targetSheetId: "target-sheet",
    targetSpreadsheetToken: "target-spreadsheet-token",
    ...input,
  };
}

async function buildFieldAlignedSourceDataset(): Promise<SourceDataset> {
  const values = buildFieldAlignedCargoSourceFixture().value;
  const downloads = new Map<string, DownloadRecord>();
  for (let index = 1; index < values.length; index += 1) {
    const image = values[index][2] as { fileToken: string };
    const skuCode = String(values[index][1]);
    downloads.set(image.fileToken, {
      bytes: await createImageBuffer(index),
      contentType: "image/png",
      fileName: `${skuCode}.png`,
    });
  }
  return { downloads, values };
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

async function waitFor(
  predicate: () => boolean,
  input?: { intervalMs?: number; timeoutMs?: number },
) {
  const startedAt = Date.now();
  const intervalMs = input?.intervalMs ?? 5;
  const timeoutMs = input?.timeoutMs ?? 5_000;

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
    input.priceYuan,
    String(input.quantity),
    String(input.quantity),
    input.productUrl,
    input.specification,
    input.color,
    input.combination,
    input.weight,
    input.status === "NOT_SELLABLE" ? "\u4e0d\u53ef\u552e" : "\u53ef\u552e",
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

async function createAdminActor(input: {
  actorKind: "ADMIN" | "SUPER_ADMIN";
  mirrorStatus?: "ACTIVE" | "DISABLED";
  role: "admin" | "super_admin";
}) {
  const userId = crypto.randomUUID();
  const email = `${input.role}-${userId}@example.test`;

  await db.insert(authUsers).values({
    banned: false,
    email,
    id: userId,
    name: `${input.role} actor`,
    role: input.role,
  });
  await db.execute(sql`
    insert into admin_users (id, login_identifier, display_name, status)
    values (${crypto.randomUUID()}::uuid, ${email}, 'Migration Mirror', ${input.mirrorStatus ?? "ACTIVE"})
  `);

  return { kind: input.actorKind, userId };
}

async function createSuperAdminActor(): Promise<SuperAdminPrincipal> {
  return (await createAdminActor({
    actorKind: "SUPER_ADMIN",
    role: "super_admin",
  })) as SuperAdminPrincipal;
}

async function createOrdinaryAdminActor() {
  return await createAdminActor({
    actorKind: "ADMIN",
    role: "admin",
  });
}

async function createForgedSuperAdminActor(): Promise<SuperAdminPrincipal> {
  return (await createAdminActor({
    actorKind: "SUPER_ADMIN",
    role: "admin",
  })) as SuperAdminPrincipal;
}

async function createDisabledMirrorSuperAdminActor(): Promise<SuperAdminPrincipal> {
  return (await createAdminActor({
    actorKind: "SUPER_ADMIN",
    mirrorStatus: "DISABLED",
    role: "super_admin",
  })) as SuperAdminPrincipal;
}

function createMutableSourceClient(input: {
  initialDataset: SourceDataset;
  revision?: number;
  sheets?: Array<{ index: number; sheetId: string; title: string }>;
  spreadsheetToken?: string;
}) {
  const state = {
    dataset: cloneDataset(input.initialDataset),
    revision: input.revision ?? 11,
    sheets:
      input.sheets ?? [
        { index: 0, sheetId: "sheet-primary", title: "Primary source sheet" },
      ],
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
      return state.sheets;
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
    setSheets(
      nextSheets: Array<{ index: number; sheetId: string; title: string }>,
    ) {
      state.sheets = nextSheets;
    },
    state,
  };
}

function createDelayedSourceClient(input: {
  initialDataset: SourceDataset;
  revision?: number;
  spreadsheetToken?: string;
}) {
  const source = createMutableSourceClient(input);
  const originalDownloadMedia = source.client.downloadMedia.bind(source.client);
  let delayFirstDownload = false;
  let downloadPaused = false;
  let releaseDownload: null | (() => void) = null;

  source.client.downloadMedia = async (fileToken: string) => {
    if (delayFirstDownload) {
      delayFirstDownload = false;
      downloadPaused = true;
      await new Promise<void>((resolve) => {
        releaseDownload = () => {
          downloadPaused = false;
          resolve();
        };
      });
    }
    return await originalDownloadMedia(fileToken);
  };

  return {
    ...source,
    armFirstDownloadDelay() {
      delayFirstDownload = true;
    },
    async releaseFirstDownload() {
      if (releaseDownload) {
        const release = releaseDownload;
        releaseDownload = null;
        release();
      }
      await waitFor(() => !downloadPaused);
    },
    async waitForFirstDownload() {
      await waitFor(() => downloadPaused);
    },
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
    process.env.FEISHU_CARGO_IMPORT_ENABLED = "true";
    process.env.FEISHU_CARGO_WRITES_ENABLED = "false";
    process.env.FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN = "target-spreadsheet-token";
    process.env.FEISHU_CARGO_TARGET_SHEET_ID = "target-sheet";
  });

  afterEach(async () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_CARGO_SOURCE_WIKI_TOKEN;
    delete process.env.FEISHU_CARGO_SOURCE_SHEET_ID;
    delete process.env.FEISHU_CARGO_IMPORT_ENABLED;
    delete process.env.FEISHU_CARGO_WRITES_ENABLED;
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
    blockedDataset.values[2][13] = "";
    const fakeSource = createMutableSourceClient({ initialDataset: blockedDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const [existingProduct] = await db
      .insert(products)
      .values({ description: "must remain unchanged", name: "Existing product" })
      .returning();
    const [existingSku] = await db
      .insert(skus)
      .values({
        defaultUnitPriceFen: 100,
        defaultUnitPriceMilliYuan: 1_000,
        name: "Existing SKU",
        productId: existingProduct.id,
        skuCode: "EXISTING-BLOCKED-SKU",
      })
      .returning();
    await db.insert(inventoryBalances).values({ skuId: existingSku.id, totalQuantity: 23 });
    const catalogBeforePreflight = {
      balances: await db.select().from(inventoryBalances),
      products: await db.select().from(products),
      skus: await db.select().from(skus),
    };

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
    expect(await db.select().from(products)).toEqual(catalogBeforePreflight.products);
    expect(await db.select().from(skus)).toEqual(catalogBeforePreflight.skus);
    expect(await db.select().from(inventoryBalances)).toEqual(catalogBeforePreflight.balances);
    expect(await db.select().from(catalogAssets)).toEqual([]);
    expect(await db.select().from(inventoryMovements)).toEqual([]);
  });

  test("sanitizes permanent source image download failures as blocking preflight issues", async () => {
    const actor = await createSuperAdminActor();
    const [existingProduct] = await db
      .insert(products)
      .values({ description: "source failure sentinel", name: "Sentinel product" })
      .returning();
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
    expect(await db.select().from(products)).toEqual([existingProduct]);
    expect(await db.select().from(skus)).toEqual([]);
    expect(await db.select().from(inventoryBalances)).toEqual([]);
    expect(await db.select().from(catalogAssets)).toEqual([]);
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
        actor: ordinaryAdmin as SuperAdminPrincipal,
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
        actor: ordinaryAdmin as SuperAdminPrincipal,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" satisfies FeishuCargoMigrationError["code"] });
  });

  test("rejects forged SUPER_ADMIN actors whose auth role is not super_admin", async () => {
    const forgedActor = await createForgedSuperAdminActor();
    const superAdmin = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    await expect(
      service.createCargoPreflight({
        actor: forgedActor,
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
        actor: forgedActor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" satisfies FeishuCargoMigrationError["code"] });
  });

  test("rejects super-admin principals whose admin mirror is inactive", async () => {
    const disabledMirrorActor = await createDisabledMirrorSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    await expect(
      service.createCargoPreflight({
        actor: disabledMirrorActor,
        client: fakeSource.client,
        config: createConfig(),
      }),
    ).rejects.toMatchObject({ code: "ACTOR_NOT_FOUND" satisfies FeishuCargoMigrationError["code"] });
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

  test("marks a preflight run stale when image bytes change and removes stale staging files", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });

    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    fakeSource.setDownloadRecord("file-token-SKU-001", {
      bytes: await createImageBuffer(201),
      contentType: "image/png",
      fileName: "SKU-001-replacement.png",
    });

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_STALE" satisfies FeishuCargoMigrationError["code"] });

    expect(await listFilesRecursively(join(assetRoot, "temporary"))).toEqual([]);
  });

  test("confirms a ready run against the preflight-selected sheet when env sourceSheetId is unset", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({
      initialDataset: baseDataset,
      sheets: [
        { index: 0, sheetId: "sheet-primary", title: "Primary source sheet" },
        { index: 1, sheetId: "sheet-secondary", title: "Secondary source sheet" },
      ],
    });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(
      await service.createCargoPreflight({
        actor,
        client: fakeSource.client,
        config: {
          ...createConfig(),
          sourceSheetId: "sheet-primary",
        },
      }),
    );

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: {
          ...createConfig(),
          sourceSheetId: undefined,
        },
        runId: readyRun.runId,
      }),
    ).resolves.toEqual({
      imageCount: 74,
      productCount: 50,
      skuCount: 74,
      sourceSequenceCount: 50,
      totalQuantity: 317,
    });
  });

  test("blocks confirmation when database import remains disabled", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
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
        config: {
          ...createConfig(),
          cargoImportEnabled: false,
        },
        runId: readyRun.runId,
      }),
    ).rejects.toThrow(/database import|数据库导入/i);
  });

  test("does not adopt a legacy product that still owns an unrelated SKU", async () => {
    const actor = await createSuperAdminActor();
    const alignedDataset = await buildFieldAlignedSourceDataset();
    const sourceRow = alignedDataset.values[1];
    const singleRowDataset = {
      downloads: alignedDataset.downloads,
      values: [alignedDataset.values[0], sourceRow],
    };
    const fakeSource = createMutableSourceClient({ initialDataset: singleRowDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));
    const [legacyProduct] = await db
      .insert(products)
      .values({
        description: "manual catalog description",
        linkText: "manual catalog link",
        name: "Manual catalog product",
      })
      .returning();
    const [matchedSku, unrelatedSku] = await db
      .insert(skus)
      .values([
        {
          defaultUnitPriceFen: 500,
          defaultUnitPriceMilliYuan: 5_000,
          name: "Legacy matching SKU",
          productId: legacyProduct.id,
          skuCode: String(sourceRow[1]),
        },
        {
          defaultUnitPriceFen: 600,
          defaultUnitPriceMilliYuan: 6_000,
          name: "Manual sibling SKU",
          productId: legacyProduct.id,
          skuCode: "MANUAL-SIBLING-SKU",
        },
      ])
      .returning();

    await service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig(),
      runId: readyRun.runId,
    });

    const [legacyProductAfter] = await db
      .select()
      .from(products)
      .where(eq(products.id, legacyProduct.id));
    const [matchedSkuAfter] = await db
      .select()
      .from(skus)
      .where(eq(skus.id, matchedSku.id));
    const [unrelatedSkuAfter] = await db
      .select()
      .from(skus)
      .where(eq(skus.id, unrelatedSku.id));

    expect(matchedSkuAfter.productId).not.toBe(legacyProduct.id);
    expect(unrelatedSkuAfter.productId).toBe(legacyProduct.id);
    expect(legacyProductAfter).toMatchObject({
      description: "manual catalog description",
      linkText: "manual catalog link",
      name: "Manual catalog product",
      sourceSequence: null,
    });
  });

  test("initializes only the missing SKU once in a mixed existing group", async () => {
    const actor = await createSuperAdminActor();
    const alignedDataset = await buildFieldAlignedSourceDataset();
    const sequenceRows = alignedDataset.values
      .slice(1)
      .filter((row) => String(row[1]).startsWith("TZX-034-"))
      .map((row) => structuredClone(row));
    expect(sequenceRows).toHaveLength(3);
    sequenceRows[2][6] = "7";
    sequenceRows[2][7] = "7";
    const sequenceDataset = {
      downloads: alignedDataset.downloads,
      values: [alignedDataset.values[0], ...sequenceRows],
    };
    const fakeSource = createMutableSourceClient({ initialDataset: sequenceDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));
    const [legacyProduct] = await db
      .insert(products)
      .values({ description: "mixed group description", name: "Mixed group product" })
      .returning();
    const existingSkus = await db
      .insert(skus)
      .values(
        sequenceRows.slice(0, 2).map((row, index) => ({
          defaultUnitPriceFen: 700 + index,
          defaultUnitPriceMilliYuan: 7_000 + index * 10,
          name: `Existing group SKU ${index + 1}`,
          productId: legacyProduct.id,
          skuCode: String(row[1]),
        })),
      )
      .returning();
    await db.insert(inventoryBalances).values(
      existingSkus.map((sku, index) => ({ skuId: sku.id, totalQuantity: 90 + index })),
    );

    const first = await service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig(),
      runId: readyRun.runId,
    });
    const second = await service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig({ cargoImportEnabled: false }),
      runId: readyRun.runId,
    });
    const groupSkuCodes = sequenceRows.map((row) => String(row[1]));
    const groupSkus = (await db.select().from(skus)).filter((sku) =>
      groupSkuCodes.includes(sku.skuCode),
    );
    const balances = await db.select().from(inventoryBalances);
    const movements = await db.select().from(inventoryMovements);
    const missingSku = groupSkus.find((sku) => sku.skuCode === String(sequenceRows[2][1]));
    if (!missingSku) throw new Error("expected missing SKU to be inserted");

    expect(second).toEqual(first);
    expect(new Set(groupSkus.map((sku) => sku.productId))).toEqual(new Set([legacyProduct.id]));
    expect(balances).toHaveLength(3);
    expect(balances).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuId: existingSkus[0].id, totalQuantity: 90 }),
      expect.objectContaining({ skuId: existingSkus[1].id, totalQuantity: 91 }),
      expect.objectContaining({
        skuId: missingSku.id,
        totalQuantity: Number(sequenceRows[2][6]),
      }),
    ]));
    expect(movements).toEqual([
      expect.objectContaining({
        afterQuantity: Number(sequenceRows[2][6]),
        beforeQuantity: 0,
        reason: "飞书初始导入",
        reasonCode: "FEISHU_INITIAL_IMPORT",
        skuId: missingSku.id,
      }),
    ]);
  });

  test("backfills 74 source sequences across 140 existing SKUs without changing operational state", async () => {
    const actor = await createSuperAdminActor();
    const alignedDataset = await buildFieldAlignedSourceDataset();
    const fakeSource = createMutableSourceClient({ initialDataset: alignedDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    const existingProducts = await db
      .insert(products)
      .values(
        alignedDataset.values.slice(1).map((row, index) => ({
          description: `preserved description ${index + 1}`,
          name: `Legacy product ${index + 1}`,
        })),
      )
      .returning({ id: products.id });
    const existingSkus = await db
      .insert(skus)
      .values(
        alignedDataset.values.slice(1).map((row, index) => ({
          defaultUnitPriceFen: 999,
          defaultUnitPriceMilliYuan: 9_990,
          name: `Legacy SKU ${index + 1}`,
          productId: existingProducts[index].id,
          skuCode: String(row[1]),
        })),
      )
      .returning({ id: skus.id, skuCode: skus.skuCode });
    await db.insert(inventoryBalances).values(
      existingSkus.map((sku, index) => ({
        skuId: sku.id,
        totalQuantity: 500 + index,
      })),
    );
    const existingSku = existingSkus.find((sku) => sku.skuCode === "TZX-034-1");
    if (!existingSku) throw new Error("expected TZX-034-1 seed");
    const [customer] = await db
      .insert(customers)
      .values({ code: "BACKFILL-CUSTOMER", name: "Backfill customer" })
      .returning();
    const [reservationBeforeBackfill] = await db
      .insert(inventoryReservations)
      .values({
        quantity: 2,
        referenceId: "backfill-reservation",
        referenceType: "TEST",
        skuId: existingSku.id,
      })
      .returning();
    const [customerPriceBeforeBackfill] = await db
      .insert(customerSkuPrices)
      .values({
        customerId: customer.id,
        skuId: existingSku.id,
        unitPriceFen: 123,
        unitPriceMilliYuan: 1_230,
      })
      .returning();
    const [balanceBeforeBackfill] = await db
      .select()
      .from(inventoryBalances)
      .where(eq(inventoryBalances.skuId, existingSku.id));

    const first = await service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig(),
      runId: readyRun.runId,
    });
    const sourceReadsAfterFirstConfirmation = fakeSource.calls.downloadMedia.length;
    const second = await service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig({ cargoImportEnabled: false }),
      runId: readyRun.runId,
    });

    const [counts] = await db.execute<{
      imageCount: number;
      skuCount: number;
      sourceSequenceCount: number;
    }>(sql`
      select
        count(distinct ${products.sourceSequence})::int as "sourceSequenceCount",
        count(distinct ${skus.id})::int as "skuCount",
        count(distinct ${skus.imageAssetId})::int as "imageCount"
      from ${skus}
      inner join ${products} on ${products.id} = ${skus.productId}
    `);
    const [balanceAfterBackfill] = await db
      .select()
      .from(inventoryBalances)
      .where(eq(inventoryBalances.skuId, existingSku.id));
    const [reservationAfterBackfill] = await db
      .select()
      .from(inventoryReservations)
      .where(eq(inventoryReservations.id, reservationBeforeBackfill.id));
    const [customerPriceAfterBackfill] = await db
      .select()
      .from(customerSkuPrices)
      .where(eq(customerSkuPrices.id, customerPriceBeforeBackfill.id));
    const [sequence34] = await db
      .select()
      .from(products)
      .where(eq(products.sourceSequence, "34"));
    const sequence34Skus = (await db.select().from(skus)).filter((sku) =>
      ["TZX-034-1", "TZX-034-2", "TZX-034-3"].includes(sku.skuCode),
    );

    expect(first).toMatchObject({
      imageCount: 140,
      productCount: 74,
      skuCount: 140,
      sourceSequenceCount: 74,
    });
    expect(second).toEqual(first);
    expect(fakeSource.calls.downloadMedia).toHaveLength(sourceReadsAfterFirstConfirmation);
    expect(counts).toEqual({ imageCount: 140, skuCount: 140, sourceSequenceCount: 74 });
    expect(await db.select().from(catalogAssets)).toHaveLength(140);
    expect(balanceAfterBackfill).toEqual(balanceBeforeBackfill);
    expect(reservationAfterBackfill).toEqual(reservationBeforeBackfill);
    expect(customerPriceAfterBackfill).toEqual(customerPriceBeforeBackfill);
    expect(sequence34).toMatchObject({
      description: "preserved description 67",
      linkText: "查看飞书商品",
      sourceSequence: "34",
    });
    expect(sequence34Skus).toHaveLength(3);
    expect(sequence34Skus.every((sku) => sku.cargoUnitPriceMilliYuan === 1_366)).toBe(true);
    expect(new Set(sequence34Skus.map((sku) => sku.productId))).toEqual(
      new Set([sequence34.id]),
    );
    expect(await db.select().from(inventoryMovements)).toEqual([]);
    expect(await db.select().from(integrationOutbox)).toEqual([]);
    expect(await db.select().from(auditLogs)).toHaveLength(1);
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
        sourceSequenceCount: 0,
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

  test("keeps shared final files when a failed import collides with another writer's published digest", async () => {
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

    let releaseSharedPublish: null | (() => void) = null;
    let sharedFinalDirectory = "";
    let sharedPublishPaused = false;
    const sharedStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      async onDirectorySync(path, reason) {
        if (reason === "publish" && path === sharedFinalDirectory && !sharedPublishPaused) {
          sharedPublishPaused = true;
          await new Promise<void>((resolve) => {
            releaseSharedPublish = resolve;
          });
        }
      },
    });
    const sharedBytes = failingDataset.downloads.get("file-token-SKU-001");
    if (!sharedBytes) {
      throw new Error("Expected shared image bytes for SKU-001");
    }
    const sharedManifest = await sharedStorage.stageCatalogAsset({
      bytes: sharedBytes.bytes,
      contentType: sharedBytes.contentType,
      originalFileName: sharedBytes.fileName,
      runId: "shared-final-run",
      skuCode: "SKU-001",
    });
    const expectedSharedStorageKey = `sha256/${sharedManifest.contentSha256.slice(0, 2)}/${sharedManifest.contentSha256}.png`;
    const sharedFinalPath = join(assetRoot, expectedSharedStorageKey);
    sharedFinalDirectory = dirname(sharedFinalPath);
    const sharedCommitPromise = sharedStorage.commitCatalogAsset(sharedManifest);

    await waitFor(() => sharedPublishPaused);
    await expect(stat(sharedFinalPath)).resolves.toBeDefined();

    const confirmPromise = service.confirmCargoMigration({
      actor,
      client: fakeSource.client,
      config: createConfig(),
      runId: readyRun.runId,
    });

    if (!releaseSharedPublish) {
      throw new Error("Expected shared final publish to pause");
    }
    const releaseSharedPublishBarrier: () => void = releaseSharedPublish;
    releaseSharedPublishBarrier();

    await expect(confirmPromise).rejects.toThrow();
    await expect(sharedCommitPromise).resolves.toBe(expectedSharedStorageKey);

    expect(await db.select().from(products)).toEqual([]);
    expect(await db.select().from(skus)).toEqual([]);
    expect(await db.select().from(inventoryBalances)).toEqual([]);
    expect(await db.select().from(inventoryMovements)).toEqual([]);
    expect(await db.select().from(catalogAssets)).toEqual([]);
    await expect(stat(sharedFinalPath)).resolves.toBeDefined();
    expect(await listFilesRecursively(join(assetRoot, "temporary"))).toEqual([]);
  });

  test("revalidates and commits freshly re-staged assets even when the preflight staging files are gone", async () => {
    const actor = await createSuperAdminActor();
    const fakeSource = createMutableSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: fakeSource.client,
      config: createConfig(),
    }));

    await rm(join(assetRoot, "temporary", readyRun.runId), { force: true, recursive: true });

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).resolves.toEqual({
      imageCount: 74,
      productCount: 50,
      skuCount: 74,
      sourceSequenceCount: 50,
      totalQuantity: 317,
    });

    expect(fakeSource.calls.downloadMedia).toHaveLength(148);
    expect(await listFilesRecursively(join(assetRoot, "temporary"))).toEqual([]);
  });

  test("reuses one committed asset when multiple SKUs have identical image bytes", async () => {
    const actor = await createSuperAdminActor();
    const dataset = await buildValidSourceDataset({ rowCount: 2 });
    const sharedImage = dataset.downloads.get("file-token-SKU-001");
    if (!sharedImage) throw new Error("Expected source image fixture");
    dataset.downloads.set("file-token-SKU-002", sharedImage);

    const fakeSource = createMutableSourceClient({ initialDataset: dataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(
      await service.createCargoPreflight({
        actor,
        client: fakeSource.client,
        config: createConfig(),
      }),
    );

    await expect(
      service.confirmCargoMigration({
        actor,
        client: fakeSource.client,
        config: createConfig(),
        runId: readyRun.runId,
      }),
    ).resolves.toEqual({
      imageCount: 2,
      productCount: 2,
      skuCount: 2,
      sourceSequenceCount: 2,
      totalQuantity: 5,
    });

    const storedAssets = await db.select().from(catalogAssets);
    const storedSkus = await db.select().from(skus);
    expect(storedAssets).toHaveLength(1);
    expect(storedSkus).toHaveLength(2);
    expect(new Set(storedSkus.map((sku) => sku.imageAssetId))).toEqual(
      new Set([storedAssets[0].id]),
    );
  });

  test("imports new SKUs with opening inventory exactly once and no target outbox event", async () => {
    const actor = await createSuperAdminActor();
    const exactDataset = cloneDataset(baseDataset);
    exactDataset.values[1][5] = "0.325";
    exactDataset.values[1][6] = "0";
    exactDataset.values[1][7] = "0";
    exactDataset.values[1][8] = "0";
    exactDataset.values[1][12] = "12.5g";
    const fakeSource = createMutableSourceClient({ initialDataset: exactDataset });
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
    const sourceReadsAfterFirstConfirmation = fakeSource.calls.downloadMedia.length;
    const repeatedResult = await service.confirmCargoMigration({
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

    expect(result).toEqual({
      imageCount: 74,
      productCount: 50,
      skuCount: 74,
      sourceSequenceCount: 50,
      totalQuantity: 315,
    });
    expect(repeatedResult).toEqual(result);
    expect(fakeSource.calls.downloadMedia).toHaveLength(sourceReadsAfterFirstConfirmation);
    expect(run?.status).toBe("IMPORTED");
    expect(importedProducts).toHaveLength(50);
    expect(importedSkus).toHaveLength(74);
    expect(importedAssets).toHaveLength(74);
    expect(balances).toHaveLength(74);
    expect(movements).toHaveLength(
      exactDataset.values.slice(1).filter((row) => Number.parseInt(String(row[6]), 10) > 0).length,
    );
    expect(importedSkus[0]).toMatchObject({
      imageUrl: `/api/catalog-assets/${importedSkus[0].imageAssetId}`,
      name: "Spec 1 / Color 1 / Combo 1",
    });
    expect(importedSkus.find((sku) => sku.skuCode === "SKU-001")).toMatchObject({
      defaultUnitPriceFen: 33,
      defaultUnitPriceMilliYuan: 325,
      productUrl: null,
      weightGrams: 13,
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
    expect(await db.select().from(integrationOutbox)).toEqual([]);

    const firstAsset = importedAssets[0];
    expect(firstAsset.storageKey).toMatch(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    expect(await listFilesRecursively(join(assetRoot, dirname(firstAsset.storageKey)))).toEqual(
      expect.arrayContaining([join(assetRoot, firstAsset.storageKey)]),
    );
  });

  test("two concurrent confirm calls both return the same idempotent import result", async () => {
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

    expect(settled).toEqual([
      {
        status: "fulfilled",
        value: {
          imageCount: 74,
          productCount: 50,
          skuCount: 74,
          sourceSequenceCount: 50,
          totalQuantity: 317,
        },
      },
      {
        status: "fulfilled",
        value: {
          imageCount: 74,
          productCount: 50,
          skuCount: 74,
          sourceSequenceCount: 50,
          totalQuantity: 317,
        },
      },
    ]);
    expect(await db.select().from(products)).toHaveLength(50);
    expect(await db.select().from(skus)).toHaveLength(74);
    expect(await db.select().from(catalogAssets)).toHaveLength(74);
    expect(await db.select().from(auditLogs)).toHaveLength(1);
    expect(await db.select().from(integrationOutbox)).toEqual([]);
  });

  test("does not hold the migration row lock while source revalidation downloads are in flight", async () => {
    const actor = await createSuperAdminActor();
    const delayedSource = createDelayedSourceClient({ initialDataset: baseDataset });
    const service = createFeishuCargoMigrationService({ assetDir: assetRoot });
    const readyRun = expectPreflightReady(await service.createCargoPreflight({
      actor,
      client: delayedSource.client,
      config: createConfig(),
    }));

    delayedSource.armFirstDownloadDelay();
    const confirmPromise = service.confirmCargoMigration({
      actor,
      client: delayedSource.client,
      config: createConfig(),
      runId: readyRun.runId,
    });

    await delayedSource.waitForFirstDownload();

    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('lock_timeout', ${"150ms"}, true)`);
          await tx
            .update(feishuCargoMigrationRuns)
            .set({ updatedAt: new Date("2026-08-13T10:45:00.000Z") })
            .where(eq(feishuCargoMigrationRuns.id, readyRun.runId));
        }),
      ).resolves.toBeUndefined();

      await delayedSource.releaseFirstDownload();

      await expect(confirmPromise).resolves.toEqual({
        imageCount: 74,
        productCount: 50,
        skuCount: 74,
        sourceSequenceCount: 50,
        totalQuantity: 317,
      });
    } finally {
      await delayedSource.releaseFirstDownload();
      await confirmPromise.catch(() => undefined);
    }
  });
});
