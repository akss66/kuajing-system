import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

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

function createReadOnlyClient(
  values: unknown[][] = buildFieldAlignedCargoSourceFixture().value,
): CatalogFieldRefreshReadPort {
  return {
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

async function seedCatalog() {
  const parsed = parseLegacyCargoSheet(buildFieldAlignedCargoSourceFixture().value);
  expect(parsed.issues).toEqual([]);
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

afterEach(async () => {
  await db.execute(sql.raw(`
    truncate table audit_logs, inventory_movements, inventory_reservations,
      inventory_balances, catalog_assets, skus, products restart identity cascade
  `));
});

describe("catalog field refresh", () => {
  test("merges split products into one source sequence without changing inventory history", async () => {
    const { canonicalProductId } = await seedCatalog();
    const before = await readInventoryFacts();
    const client = createReadOnlyClient();
    const service = createCatalogFieldRefreshService();

    const result = await service.apply({ actorUserId: "refresh-actor", client, ...validInput });

    expect(result).toMatchObject({ matchedSkuCount: 140, skuCount: 140, sourceSequenceCount: 74 });
    expect(await productIdsFor(["TZX-034-1", "TZX-034-2", "TZX-034-3"]))
      .toEqual([canonicalProductId, canonicalProductId, canonicalProductId]);
    expect(await readInventoryFacts()).toEqual(before);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "CATALOG_FIELDS_REFRESHED_FROM_FEISHU")))
      .toHaveLength(1);
    expect(Object.keys(client).sort()).toEqual(["listSheets", "readRangeDetails", "resolveWikiSpreadsheet"]);
  });

  test("leaves PostgreSQL unchanged when source and database SKU sets differ", async () => {
    await seedCatalog();
    const [removed] = await db.select({ id: skus.id }).from(skus).where(eq(skus.skuCode, "TZX-074-1"));
    await db.delete(skus).where(eq(skus.id, removed.id));
    const beforeCatalogFacts = {
      products: await db.select().from(products).orderBy(asc(products.id)),
      skus: await db.select().from(skus).orderBy(asc(skus.id)),
    };
    const service = createCatalogFieldRefreshService();

    await expect(service.apply({ actorUserId: "refresh-actor", client: createReadOnlyClient(), ...validInput }))
      .rejects.toThrow("SKU_SET_MISMATCH");
    expect({
      products: await db.select().from(products).orderBy(asc(products.id)),
      skus: await db.select().from(skus).orderBy(asc(skus.id)),
    }).toEqual(beforeCatalogFacts);
  });

  test("blocks preview when one source sequence reuses a different TZX product number", async () => {
    await seedCatalog();
    const service = createCatalogFieldRefreshService();

    await expect(service.preview({
      client: createReadOnlyClient(createRepeatedSourceSequenceValues()),
      ...validInput,
    })).rejects.toThrow("PARSER_BLOCKING_ISSUES");
  });
});
