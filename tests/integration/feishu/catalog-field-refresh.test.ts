import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  products,
  skus,
} from "@/db/schema";
import {
  createCatalogFieldRefreshService,
  type CatalogFieldRefreshReadPort,
} from "@/modules/feishu/catalog-field-refresh";
import { parseLegacyCargoSheet } from "@/modules/feishu/cargo-parser";
import type { CargoPricePlaceholder } from "@/modules/feishu/cargo-types";
import { buildFieldAlignedCargoSourceFixture } from "../../fixtures/feishu/field-aligned-cargo-source";

const sourceWikiToken = "read-only-wiki-token";
const sourceSheetId = "read-only-sheet";

function createRepeatedSourceSequenceValues() {
  const values = buildFieldAlignedCargoSourceFixture().value;
  const sequenceIndex = values[0].indexOf("序号");
  const skuIndex = values[0].indexOf("SKU");
  const cargoPriceIndex = values[0].indexOf("货品价格");
  const repeatedRow = values.find(
    (row, index) => index > 0 && row[skuIndex] === "TZX-034-3",
  );
  const sequence74LeaderIndex = values.findIndex(
    (row, index) => index > 0 && row[skuIndex] === "TZX-074-1",
  );
  if (
    sequenceIndex === -1 ||
    skuIndex === -1 ||
    cargoPriceIndex === -1 ||
    !repeatedRow ||
    sequence74LeaderIndex === -1
  ) {
    throw new Error("FIELD_ALIGNED_REPEAT_FIXTURE_SETUP_FAILED");
  }
  repeatedRow[sequenceIndex] = "74";
  repeatedRow[cargoPriceIndex] = "";
  values.splice(
    sequence74LeaderIndex + 1,
    0,
    values.splice(values.indexOf(repeatedRow), 1)[0]!,
  );
  return values;
}

function createCargoPricePlaceholderValues() {
  const values = buildFieldAlignedCargoSourceFixture().value;
  const sequenceIndex = values[0].indexOf("序号");
  const skuIndex = values[0].indexOf("SKU");
  const cargoPriceIndex = values[0].indexOf("货品价格");
  const placeholderRow = values.find(
    (row, index) => index > 0 && row[skuIndex] === "TZX-074-1",
  );
  if (
    sequenceIndex === -1 ||
    skuIndex === -1 ||
    cargoPriceIndex === -1 ||
    !placeholderRow
  ) {
    throw new Error("FIELD_ALIGNED_PLACEHOLDER_FIXTURE_SETUP_FAILED");
  }
  placeholderRow[sequenceIndex] = "76";
  placeholderRow[skuIndex] = "TZX-076";
  placeholderRow[cargoPriceIndex] = "";
  return values;
}

function createSpecificationValues(specification: string) {
  const values = structuredClone(buildFieldAlignedCargoSourceFixture().value);
  const skuIndex = values[0].indexOf("SKU");
  const specificationIndex = values[0].indexOf("规格");
  const row = values.find(
    (candidate, index) => index > 0 && candidate[skuIndex] === "TZX-034-1",
  );
  if (skuIndex < 0 || specificationIndex < 0 || !row) {
    throw new Error("FIELD_ALIGNED_SPECIFICATION_FIXTURE_SETUP_FAILED");
  }
  row[specificationIndex] = specification;
  return values;
}

function createValuesWithoutSku(skuCode: string) {
  const values = structuredClone(buildFieldAlignedCargoSourceFixture().value);
  const skuIndex = values[0].indexOf("SKU");
  const rowIndex = values.findIndex(
    (row, index) => index > 0 && row[skuIndex] === skuCode,
  );
  if (skuIndex < 0 || rowIndex < 0) {
    throw new Error("FIELD_ALIGNED_REMOVE_SKU_FIXTURE_SETUP_FAILED");
  }
  values.splice(rowIndex, 1);
  return values;
}

function createValuesWithNewAndIncompleteSkus() {
  const values = structuredClone(buildFieldAlignedCargoSourceFixture().value);
  const header = values[0];
  const sequenceIndex = header.indexOf("序号");
  const imageIndex = header.indexOf("图片");
  const nameIndex = header.indexOf("名称");
  const skuIndex = header.indexOf("SKU");
  const cargoPriceIndex = header.indexOf("货品价格");
  const defaultPriceIndex = header.indexOf("采购价");
  const quantityIndex = header.indexOf("总库存");
  const linkIndex = header.indexOf("链接文字");
  const specificationIndex = header.indexOf("规格");
  const colorIndex = header.indexOf("颜色");
  const combinationIndex = header.indexOf("组合销售");
  const weightIndex = header.indexOf("重量");
  const statusIndex = header.indexOf("状态");
  const template = values.at(-1);
  if (
    sequenceIndex < 0 ||
    imageIndex < 0 ||
    nameIndex < 0 ||
    skuIndex < 0 ||
    cargoPriceIndex < 0 ||
    defaultPriceIndex < 0 ||
    quantityIndex < 0 ||
    linkIndex < 0 ||
    specificationIndex < 0 ||
    colorIndex < 0 ||
    combinationIndex < 0 ||
    weightIndex < 0 ||
    statusIndex < 0 ||
    !template
  ) {
    throw new Error("FIELD_ALIGNED_EXTRA_DRAFT_FIXTURE_SETUP_FAILED");
  }

  const existingSku = values.find(
    (row, index) => index > 0 && row[skuIndex] === "TZX-034-1",
  );
  if (!existingSku) throw new Error("FIELD_ALIGNED_EXISTING_SKU_SETUP_FAILED");
  existingSku[quantityIndex] = "999";

  const existingProductNewSku = structuredClone(template);
  existingProductNewSku[sequenceIndex] = "";
  existingProductNewSku[imageIndex] = { fileToken: "field-aligned-image-TZX-074-2" };
  existingProductNewSku[nameIndex] = "";
  existingProductNewSku[skuIndex] = "TZX-074-2";
  existingProductNewSku[cargoPriceIndex] = "";
  existingProductNewSku[defaultPriceIndex] = "";
  existingProductNewSku[quantityIndex] = "2";
  existingProductNewSku[linkIndex] = "";
  existingProductNewSku[specificationIndex] = "";
  existingProductNewSku[colorIndex] = "颜色 2";
  existingProductNewSku[combinationIndex] = "";
  existingProductNewSku[weightIndex] = "";
  existingProductNewSku[statusIndex] = "";
  values.push(existingProductNewSku);

  const completeNewSku = structuredClone(template);
  completeNewSku[sequenceIndex] = "75";
  completeNewSku[imageIndex] = { fileToken: "field-aligned-image-TZX-075" };
  completeNewSku[nameIndex] = "新增完整商品";
  completeNewSku[skuIndex] = "TZX-075";
  completeNewSku[cargoPriceIndex] = "12.345";
  completeNewSku[defaultPriceIndex] = "5.678";
  completeNewSku[quantityIndex] = "4";
  completeNewSku[linkIndex] = {
    link: "https://example.test/feishu/75",
    text: "查看新增商品",
  };
  completeNewSku[specificationIndex] = "完整款";
  completeNewSku[colorIndex] = "黑色";
  completeNewSku[combinationIndex] = "单个";
  completeNewSku[weightIndex] = "120g";
  completeNewSku[statusIndex] = "可售";
  values.push(completeNewSku);

  const incompleteNewSku = structuredClone(template);
  incompleteNewSku[sequenceIndex] = "76";
  incompleteNewSku[imageIndex] = [
    { fileToken: "ambiguous-a" },
    { fileToken: "ambiguous-b" },
  ];
  incompleteNewSku[nameIndex] = "新增草稿商品";
  incompleteNewSku[skuIndex] = "TZX-076";
  incompleteNewSku[cargoPriceIndex] = "";
  incompleteNewSku[defaultPriceIndex] = "";
  incompleteNewSku[quantityIndex] = "";
  incompleteNewSku[linkIndex] = "";
  incompleteNewSku[specificationIndex] = "";
  incompleteNewSku[colorIndex] = "";
  incompleteNewSku[combinationIndex] = "";
  incompleteNewSku[weightIndex] = "";
  incompleteNewSku[statusIndex] = "可售";
  values.push(incompleteNewSku);

  const strayDraftRow = new Array(header.length).fill("");
  strayDraftRow[nameIndex] = "尚未填写 SKU 的草稿";
  values.push(strayDraftRow);
  return values;
}

let imageBytes = new Uint8Array();

function createReadOnlyClient(
  values: unknown[][] = buildFieldAlignedCargoSourceFixture().value,
): CatalogFieldRefreshReadPort {
  return {
    async downloadMedia(fileToken) {
      return {
        bytes: imageBytes,
        contentType: "image/png",
        fileName: `${fileToken}.png`,
      };
    },
    async listSheets() {
      return [{ index: 0, sheetId: sourceSheetId, title: "Read-only catalog" }];
    },
    async readRangeDetails(input) {
      return { range: input.range, revision: 1, values };
    },
    async resolveWikiSpreadsheet() {
      return { spreadsheetToken: "read-only-spreadsheet" };
    },
  };
}

async function seedCatalog(
  values: unknown[][] = buildFieldAlignedCargoSourceFixture().value,
  cargoPricePlaceholders: readonly CargoPricePlaceholder[] = [],
) {
  const parsed = parseLegacyCargoSheet(values, { cargoPricePlaceholders });
  expect(parsed.issues.filter((issue) => issue.severity === "BLOCKING")).toEqual([]);
  const canonicalSequence = "34";
  const rowsBySequence = Map.groupBy(parsed.rows, (row) => row.sourceSequence);
  const skuIdByCode = new Map<string, string>();
  let canonicalProductId = "";

  for (const [sequence, rows] of rowsBySequence) {
    const productRows = sequence === canonicalSequence
      ? [{ rows: rows!.slice(0, 2) }, { rows: rows!.slice(2) }]
      : [{ rows: rows! }];
    for (const group of productRows) {
      const [product] = await db.insert(products).values({ name: `Legacy ${sequence}` }).returning({ id: products.id });
      if (sequence === canonicalSequence && canonicalProductId.length === 0) canonicalProductId = product.id;
      for (const row of group.rows) {
        const [sku] = await db.insert(skus).values({
          cargoUnitPriceMilliYuan: row.cargoUnitPriceMilliYuan,
          defaultUnitPriceFen: row.defaultUnitPriceFen,
          defaultUnitPriceMilliYuan: row.defaultUnitPriceMilliYuan,
          name: `Legacy ${row.skuCode}`,
          productId: product.id,
          skuCode: row.skuCode,
        }).returning({ id: skus.id });
        skuIdByCode.set(row.skuCode, sku.id);
      }
    }
  }

  const protectedSkuId = skuIdByCode.get("TZX-034-1")!;
  await db.insert(inventoryBalances).values({ skuId: protectedSkuId, totalQuantity: 7 });
  await db.insert(inventoryReservations).values({
    quantity: 2, referenceId: "refresh-protection", referenceType: "test", skuId: protectedSkuId,
  });
  await db.insert(inventoryMovements).values({
    actorType: "ADMIN", afterQuantity: 7, beforeQuantity: 0, delta: 7,
    movementType: "MANUAL_INCREASE", reason: "test inventory fact", reasonCode: "OTHER", skuId: protectedSkuId,
  });

  return { canonicalProductId, protectedSkuId };
}

async function readInventoryFacts() {
  return {
    balances: await db.select().from(inventoryBalances).orderBy(asc(inventoryBalances.skuId)),
    movements: await db.select().from(inventoryMovements).orderBy(asc(inventoryMovements.id)),
    reservations: await db.select().from(inventoryReservations).orderBy(asc(inventoryReservations.id)),
  };
}

async function productIdsFor(skuCodes: string[]) {
  return (await db.select({ productId: skus.productId }).from(skus)
    .where(inArray(skus.skuCode, skuCodes)).orderBy(asc(skus.skuCode))).map((row) => row.productId);
}

const validInput = {
  expectedSkuCount: 140,
  expectedSourceSequenceCount: 74,
  reason: "Repair legacy source fields from the read-only source catalog",
  sourceSheetId,
  sourceWikiToken,
};

let assetRoot = "";

beforeEach(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "catalog-field-refresh-"));
  imageBytes = await sharp({
    create: {
      background: { alpha: 1, b: 120, g: 80, r: 40 },
      channels: 4,
      height: 2,
      width: 2,
    },
  })
    .png()
    .toBuffer();
});

afterEach(async () => {
  await db.execute(sql.raw(`
    truncate table audit_logs, inventory_movements, inventory_reservations,
      inventory_balances, catalog_assets, skus, products restart identity cascade
  `));
  if (assetRoot) await rm(assetRoot, { force: true, recursive: true });
  assetRoot = "";
});

describe("catalog field refresh", () => {
  test("creates exact Feishu SKUs, preserves nulls as non-sellable drafts, and initializes inventory once", async () => {
    await seedCatalog();
    const beforeExistingInventory = await readInventoryFacts();
    const values = createValuesWithNewAndIncompleteSkus();
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    const firstResult = await (
      service.apply({
        actorUserId: "refresh-actor",
        client: createReadOnlyClient(values),
        ...validInput,
      })
    );
    expect(firstResult).toMatchObject({
      createdProductCount: 2,
      createdSkuCount: 3,
      degradedSkuCount: 1,
      matchedSkuCount: 140,
      skuCount: 143,
    });

    const newSkus = await db
      .select({
        cargoUnitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
        defaultUnitPriceFen: skus.defaultUnitPriceFen,
        defaultUnitPriceMilliYuan: skus.defaultUnitPriceMilliYuan,
        id: skus.id,
        imageAssetId: skus.imageAssetId,
        imageUrl: skus.imageUrl,
        saleStatus: skus.saleStatus,
        skuCode: skus.skuCode,
      })
      .from(skus)
      .where(inArray(skus.skuCode, ["TZX-074-2", "TZX-075", "TZX-076"]))
      .orderBy(asc(skus.skuCode));
    expect(newSkus).toHaveLength(3);
    expect(newSkus[1]).toMatchObject({
      cargoUnitPriceMilliYuan: 12_345,
      defaultUnitPriceFen: 568,
      defaultUnitPriceMilliYuan: 5_678,
      saleStatus: "SELLABLE",
      skuCode: "TZX-075",
    });
    expect(newSkus[1]?.imageAssetId).not.toBeNull();
    expect(newSkus[1]?.imageUrl).toMatch(/^\/api\/catalog-assets\//);
    expect(newSkus[2]).toMatchObject({
      cargoUnitPriceMilliYuan: null,
      defaultUnitPriceFen: null,
      defaultUnitPriceMilliYuan: null,
      imageAssetId: null,
      imageUrl: null,
      saleStatus: "NOT_SELLABLE",
      skuCode: "TZX-076",
    });

    const balanceRows = await db
      .select({ skuId: inventoryBalances.skuId, totalQuantity: inventoryBalances.totalQuantity })
      .from(inventoryBalances)
      .where(inArray(inventoryBalances.skuId, newSkus.map((row) => row.id)))
      .orderBy(asc(inventoryBalances.totalQuantity));
    expect(balanceRows.map((row) => row.totalQuantity)).toEqual([0, 2, 4]);
    const initialMovements = await db
      .select({ delta: inventoryMovements.delta, reasonCode: inventoryMovements.reasonCode })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.reasonCode, "FEISHU_INITIAL_IMPORT"))
      .orderBy(asc(inventoryMovements.delta));
    expect(initialMovements).toEqual([
      { delta: 2, reasonCode: "FEISHU_INITIAL_IMPORT" },
      { delta: 4, reasonCode: "FEISHU_INITIAL_IMPORT" },
    ]);

    const [protectedBalance] = await db
      .select({ totalQuantity: inventoryBalances.totalQuantity })
      .from(inventoryBalances)
      .where(eq(inventoryBalances.skuId, beforeExistingInventory.balances[0]!.skuId));
    expect(protectedBalance?.totalQuantity).toBe(7);

    const inventoryAfterFirstApply = await readInventoryFacts();
    await expect(
      service.apply({
        actorUserId: "refresh-actor",
        client: createReadOnlyClient(values),
        ...validInput,
      }),
    ).resolves.toMatchObject({ createdProductCount: 0, createdSkuCount: 0 });
    expect(await readInventoryFacts()).toEqual(inventoryAfterFirstApply);
  });

  test("re-resolves products and SKUs created concurrently without resetting their inventory", async () => {
    await seedCatalog();
    const values = createValuesWithNewAndIncompleteSkus();
    const client = createReadOnlyClient(values);
    const originalDownload = client.downloadMedia;
    let concurrentSkuId = "";
    let inserted = false;
    client.downloadMedia = async (fileToken) => {
      if (!inserted) {
        inserted = true;
        const [product] = await db
          .insert(products)
          .values({ name: "Concurrent product", sourceSequence: "75" })
          .returning({ id: products.id });
        const [sku] = await db
          .insert(skus)
          .values({
            cargoUnitPriceMilliYuan: 1_000,
            defaultUnitPriceFen: 100,
            defaultUnitPriceMilliYuan: 1_000,
            name: "Concurrent SKU",
            productId: product.id,
            skuCode: "TZX-075",
          })
          .returning({ id: skus.id });
        concurrentSkuId = sku.id;
        await db
          .insert(inventoryBalances)
          .values({ skuId: concurrentSkuId, totalQuantity: 11 });
      }
      return await originalDownload(fileToken);
    };

    await expect(
      createCatalogFieldRefreshService({ assetDir: assetRoot }).apply({
        actorUserId: "refresh-actor",
        client,
        ...validInput,
      }),
    ).resolves.toMatchObject({ skuCount: 143 });

    expect(
      await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.sourceSequence, "75")),
    ).toHaveLength(1);
    const refreshed = await db
      .select({
        cargoUnitPriceMilliYuan: skus.cargoUnitPriceMilliYuan,
        id: skus.id,
        productId: skus.productId,
      })
      .from(skus)
      .where(eq(skus.skuCode, "TZX-075"));
    expect(refreshed).toEqual([
      expect.objectContaining({
        cargoUnitPriceMilliYuan: 12_345,
        id: concurrentSkuId,
      }),
    ]);
    await expect(
      db
        .select({ totalQuantity: inventoryBalances.totalQuantity })
        .from(inventoryBalances)
        .where(eq(inventoryBalances.skuId, concurrentSkuId)),
    ).resolves.toEqual([{ totalQuantity: 11 }]);
    await expect(
      db
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.skuId, concurrentSkuId)),
    ).resolves.toEqual([]);
  });

  test("serializes the Feishu read with apply so an older slow response cannot overwrite a newer click", async () => {
    await seedCatalog();
    const olderClient = createReadOnlyClient(createSpecificationValues("旧快照"));
    const newerClient = createReadOnlyClient(createSpecificationValues("新快照"));
    const originalRead = olderClient.readRangeDetails;
    let releaseOlderRead!: () => void;
    let signalOlderReadStarted!: () => void;
    const olderReadGate = new Promise<void>((resolve) => {
      releaseOlderRead = resolve;
    });
    const olderReadStarted = new Promise<void>((resolve) => {
      signalOlderReadStarted = resolve;
    });
    olderClient.readRangeDetails = async (input) => {
      signalOlderReadStarted();
      await olderReadGate;
      return await originalRead(input);
    };
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    const olderApply = service.apply({
      actorUserId: "older-refresh",
      client: olderClient,
      ...validInput,
    });
    await olderReadStarted;
    const newerApply = service.apply({
      actorUserId: "newer-refresh",
      client: newerClient,
      ...validInput,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseOlderRead();
    await Promise.all([olderApply, newerApply]);

    const [row] = await db
      .select({ specification: skus.specification })
      .from(skus)
      .where(eq(skus.skuCode, "TZX-034-1"));
    expect(row?.specification).toBe("新快照");
  });

  test("uses a real Feishu value without retaining a legacy placeholder", async () => {
    await seedCatalog();
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    await expect(service.apply({
      actorUserId: "refresh-actor",
      cargoPricePlaceholders: [
        { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
      ],
      client: createReadOnlyClient(),
      ...validInput,
    })).resolves.toMatchObject({ cargoPricePlaceholders: [] });
  });

  test("ignores legacy placeholders so an empty Feishu price stays null and not sellable", async () => {
    const values = createCargoPricePlaceholderValues();
    const cargoPricePlaceholders = [
      { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
    ];
    await seedCatalog(values, cargoPricePlaceholders);
    const client = createReadOnlyClient(values);
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    await expect(service.preview({
      client,
      cargoPricePlaceholders,
      ...validInput,
    })).resolves.toMatchObject({ cargoPricePlaceholders: [], degradedSkuCount: 1 });

    await expect(service.apply({
      actorUserId: "refresh-actor",
      client,
      cargoPricePlaceholders,
      ...validInput,
    })).resolves.toMatchObject({ cargoPricePlaceholders: [], degradedSkuCount: 1 });

    const refreshedPrices = await db.execute<{
      cargoUnitPriceMilliYuan: number | null;
      saleStatus: "SELLABLE" | "NOT_SELLABLE";
    }>(sql`
      select cargo_unit_price_milli_yuan as "cargoUnitPriceMilliYuan",
        sale_status as "saleStatus"
      from skus
      where sku_code = 'TZX-076'
    `);
    expect(refreshedPrices).toEqual([
      { cargoUnitPriceMilliYuan: null, saleStatus: "NOT_SELLABLE" },
    ]);

    const [auditLog] = await db.select({ afterJson: auditLogs.afterJson }).from(auditLogs)
      .where(eq(auditLogs.action, "CATALOG_FIELDS_REFRESHED_FROM_FEISHU"));
    expect(auditLog?.afterJson).toMatchObject({
      degradedSkuCount: 1,
    });
    expect(auditLog?.afterJson).not.toHaveProperty("cargoPricePlaceholders");
  });

  test("merges split products into one source sequence without changing inventory history", async () => {
    const { canonicalProductId } = await seedCatalog();
    const before = await readInventoryFacts();
    const client = createReadOnlyClient();
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    const result = await service.apply({ actorUserId: "refresh-actor", client, ...validInput });

    expect(result).toMatchObject({ matchedSkuCount: 140, skuCount: 140, sourceSequenceCount: 74 });
    expect(await productIdsFor(["TZX-034-1", "TZX-034-2", "TZX-034-3"]))
      .toEqual([canonicalProductId, canonicalProductId, canonicalProductId]);
    expect(await readInventoryFacts()).toEqual(before);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "CATALOG_FIELDS_REFRESHED_FROM_FEISHU")))
      .toHaveLength(1);
    expect(Object.keys(client).sort()).toEqual([
      "downloadMedia",
      "listSheets",
      "readRangeDetails",
      "resolveWikiSpreadsheet",
    ]);
  });

  test("recreates a Feishu SKU that is absent from PostgreSQL", async () => {
    await seedCatalog();
    const [removed] = await db.select({ id: skus.id }).from(skus).where(eq(skus.skuCode, "TZX-074-1"));
    await db.delete(skus).where(eq(skus.id, removed.id));
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    await expect(
      service.apply({
        actorUserId: "refresh-actor",
        client: createReadOnlyClient(),
        ...validInput,
      }),
    ).resolves.toMatchObject({ createdSkuCount: 1, matchedSkuCount: 139 });
    expect(
      await db.select().from(skus).where(eq(skus.skuCode, "TZX-074-1")),
    ).toHaveLength(1);
  });

  test("keeps a historical system SKU when it is temporarily absent from Feishu", async () => {
    await seedCatalog();
    const [before] = await db
      .select()
      .from(skus)
      .where(eq(skus.skuCode, "TZX-074-1"));

    await expect(
      createCatalogFieldRefreshService({ assetDir: assetRoot }).apply({
        actorUserId: "refresh-actor",
        client: createReadOnlyClient(createValuesWithoutSku("TZX-074-1")),
        ...validInput,
      }),
    ).resolves.toMatchObject({ createdSkuCount: 0, matchedSkuCount: 139 });

    const [after] = await db
      .select()
      .from(skus)
      .where(eq(skus.skuCode, "TZX-074-1"));
    expect(after).toEqual(before);
  });

  test("rolls back all database changes when a source image cannot be read", async () => {
    await seedCatalog();
    const before = {
      products: await db.select().from(products).orderBy(asc(products.id)),
      skus: await db.select().from(skus).orderBy(asc(skus.id)),
    };
    const client = createReadOnlyClient(createSpecificationValues("不会落库"));
    client.downloadMedia = async () => {
      throw new Error("third-party-secret-token");
    };

    await expect(
      createCatalogFieldRefreshService({ assetDir: assetRoot }).apply({
        actorUserId: "refresh-actor",
        client,
        ...validInput,
      }),
    ).rejects.toThrow("SOURCE_IMAGE_DOWNLOAD_FAILED");
    expect({
      products: await db.select().from(products).orderBy(asc(products.id)),
      skus: await db.select().from(skus).orderBy(asc(skus.id)),
    }).toEqual(before);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "CATALOG_FIELDS_REFRESHED_FROM_FEISHU")),
    ).toEqual([]);
  });

  test("rejects crossed product grouping instead of reusing one canonical product twice", async () => {
    const { canonicalProductId } = await seedCatalog();
    const foreignSkus = await db
      .select({ id: skus.id })
      .from(skus)
      .where(inArray(skus.skuCode, ["TZX-035-1", "TZX-035-2"]));
    expect(foreignSkus).toHaveLength(2);
    await db
      .update(skus)
      .set({ productId: canonicalProductId })
      .where(inArray(skus.id, foreignSkus.map((row) => row.id)));
    const before = {
      products: await db.select().from(products).orderBy(asc(products.id)),
      skus: await db.select().from(skus).orderBy(asc(skus.id)),
    };

    await expect(
      createCatalogFieldRefreshService({ assetDir: assetRoot }).apply({
        actorUserId: "refresh-actor",
        client: createReadOnlyClient(),
        ...validInput,
      }),
    ).rejects.toThrow("PRODUCT_GROUPING_CONFLICT");
    expect({
      products: await db.select().from(products).orderBy(asc(products.id)),
      skus: await db.select().from(skus).orderBy(asc(skus.id)),
    }).toEqual(before);
  });

  test("blocks preview when one source sequence reuses a different TZX product number", async () => {
    await seedCatalog();
    const service = createCatalogFieldRefreshService({ assetDir: assetRoot });

    await expect(service.preview({
      client: createReadOnlyClient(createRepeatedSourceSequenceValues()),
      ...validInput,
    })).rejects.toThrow("PARSER_BLOCKING_ISSUES");
  });
});
