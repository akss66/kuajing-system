import { and, eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  auditLogs,
  bulkImportDrafts,
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
  addStoreGroup,
  createBulkDraft,
  getBulkDraft,
  removeGroupFile,
  uploadGroupFiles,
  type BulkDraftUploadFile,
} from "@/modules/bulk-order/draft-service";
import { TEMU_EXPORT_HEADERS } from "@/modules/order-import/temu-parser";
import { decryptPii } from "@/shared/pii-crypto";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const baseRow: Record<(typeof TEMU_EXPORT_HEADERS)[number], string | number> = {
  订单号: "PO-BULK-1",
  站点: "加拿大",
  订单状态: "待发货",
  子订单号: "SUB-BULK-1",
  应履约件数: 1,
  商品名称: "批量商品",
  SKUID: "SKUID-1",
  SKCID: "SKCID-1",
  SPUID: "SPUID-1",
  SKU货号: "TZX-BULK-KNOWN",
  商品属性: "蓝色",
  收货人姓名: "Bulk Recipient",
  收货人联系方式: "+1 416 555 0100",
  备用联系方式: "",
  邮箱: "bulk-recipient@example.test",
  身份证号: "",
  税号: "",
  详细地址1: "100 Private Avenue",
  详细地址2: "",
  详细地址3: "",
  区县: "Toronto",
  城市: "Toronto",
  省份: "Ontario",
  收货地址邮编: "M5V 3A8",
  国家: "Canada",
  运单号: "",
  物流商: "",
  发货仓: "",
  订单创建时间: "2026-08-12 10:00:00",
  要求最晚发货时间: "2026-08-14 10:00:00",
  实际发货时间: "",
  预计送达时间: "",
  实际签收时间: "",
};

async function workbookFile(input?: {
  fileName?: string;
  mimeType?: string;
  row?: Partial<typeof baseRow>;
}): Promise<BulkDraftUploadFile> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("sheet1");
  worksheet.addRow([...TEMU_EXPORT_HEADERS]);
  const row = { ...baseRow, ...input?.row };
  worksheet.addRow(TEMU_EXPORT_HEADERS.map((header) => row[header] ?? ""));
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: input?.fileName ?? "TEMU-orders.xlsx",
    mimeType: input?.mimeType ?? XLSX_MIME,
  };
}

async function tooManyRowsFile(): Promise<BulkDraftUploadFile> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("sheet1");
  worksheet.addRow([...TEMU_EXPORT_HEADERS]);
  for (let index = 0; index < 50_001; index += 1) {
    worksheet.addRow([`row-${index}`]);
  }
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: "too-many.xlsx",
    mimeType: XLSX_MIME,
  };
}

async function createFixture() {
  const [customer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "批量客户" })
    .returning();
  const [otherCustomer] = await db
    .insert(customers)
    .values({ code: crypto.randomUUID(), name: "其他客户" })
    .returning();
  const [store] = await db
    .insert(stores)
    .values({ customerId: customer.id, name: "批量店铺" })
    .returning();
  const [disabledStore] = await db
    .insert(stores)
    .values({
      customerId: customer.id,
      name: "停用店铺",
      status: "DISABLED",
    })
    .returning();
  const [otherStore] = await db
    .insert(stores)
    .values({ customerId: otherCustomer.id, name: "其他店铺" })
    .returning();
  const [product] = await db
    .insert(products)
    .values({ name: "批量商品" })
    .returning();
  const [sku] = await db
    .insert(skus)
    .values({
      cargoUnitPriceMilliYuan: 6_000,
      defaultUnitPriceFen: 600,
      name: "蓝色",
      productId: product.id,
      skuCode: `BULK-${crypto.randomUUID()}`,
    })
    .returning();
  await db.insert(skuAliases).values({
    externalSku: "TZX-BULK-KNOWN",
    skuId: sku.id,
    storeId: store.id,
  });
  await db.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 10 });

  return { customer, disabledStore, otherCustomer, otherStore, sku, store };
}

async function seedBatch(input: {
  customerId: string;
  groupId: string;
  index: number;
  storeId: string;
}) {
  await db.insert(orderImportBatches).values({
    customerId: input.customerId,
    expiresAt: new Date(Date.now() + 60_000),
    fileSha256: input.index.toString(16).padStart(64, "0"),
    fileSizeBytes: 1,
    originalFileName: `seed-${input.index}.xlsx`,
    storeGroupId: input.groupId,
    storeId: input.storeId,
  });
}

describe("24-hour multi-store bulk import drafts", () => {
  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        audit_logs,
        order_import_rows,
        order_import_batches,
        bulk_import_store_groups,
        bulk_import_drafts,
        sku_aliases,
        skus,
        products,
        stores,
        customers
      restart identity cascade
    `));
  });

  test("creates an exact 24-hour customer draft and restores it by customer id after login", async () => {
    const fixture = await createFixture();
    const created = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });

    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(
      24 * 60 * 60 * 1_000,
    );
    await expect(
      getBulkDraft(fixture.customer.id, created.id),
    ).resolves.toMatchObject({
      customerId: fixture.customer.id,
      groups: [],
      id: created.id,
      status: "DRAFT",
    });
    await expect(
      getBulkDraft(fixture.otherCustomer.id, created.id),
    ).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
  });

  test("requires an active owned store and keeps one group per store in a draft", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });

    await expect(
      addStoreGroup({
        customerId: fixture.customer.id,
        draftId: draft.id,
        storeId: fixture.otherStore.id,
      }),
    ).rejects.toMatchObject({ code: "STORE_NOT_OWNED" });
    await expect(
      addStoreGroup({
        customerId: fixture.customer.id,
        draftId: draft.id,
        storeId: fixture.disabledStore.id,
      }),
    ).rejects.toMatchObject({ code: "STORE_DISABLED" });

    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    expect(group).toMatchObject({
      customerId: fixture.customer.id,
      draftId: draft.id,
      files: [],
      storeId: fixture.store.id,
      storeName: fixture.store.name,
    });
    await expect(
      addStoreGroup({
        customerId: fixture.customer.id,
        draftId: draft.id,
        storeId: fixture.store.id,
      }),
    ).rejects.toMatchObject({ code: "STORE_GROUP_EXISTS" });
  });

  test("serializes concurrent group additions so no draft can exceed 20 stores", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const newStores = await db
      .insert(stores)
      .values(
        Array.from({ length: 21 }, (_, index) => ({
          customerId: fixture.customer.id,
          name: `并发店铺-${index}-${crypto.randomUUID()}`,
        })),
      )
      .returning({ id: stores.id });

    const results = await Promise.allSettled(
      newStores.map((store) =>
        addStoreGroup({
          customerId: fixture.customer.id,
          draftId: draft.id,
          storeId: store.id,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      20,
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "GROUP_LIMIT" });
    expect((await getBulkDraft(fixture.customer.id, draft.id)).groups).toHaveLength(
      20,
    );
  });

  test("uploads at most 10 files per group and 100 files per draft", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    const file = await workbookFile();

    await expect(
      uploadGroupFiles({
        customerId: fixture.customer.id,
        files: Array.from({ length: 11 }, (_, index) => ({
          ...file,
          fileName: `too-many-${index}.xlsx`,
        })),
        groupId: group.id,
      }),
    ).rejects.toMatchObject({ code: "GROUP_FILE_LIMIT" });

    const extraStores = await db
      .insert(stores)
      .values(
        Array.from({ length: 10 }, (_, index) => ({
          customerId: fixture.customer.id,
          name: `配额店铺-${index}-${crypto.randomUUID()}`,
        })),
      )
      .returning({ id: stores.id });
    const groups = [group];
    for (const store of extraStores) {
      groups.push(
        await addStoreGroup({
          customerId: fixture.customer.id,
          draftId: draft.id,
          storeId: store.id,
        }),
      );
    }
    let seedIndex = 1;
    for (const seededGroup of groups.slice(1)) {
      for (let count = 0; count < 10; count += 1) {
        await seedBatch({
          customerId: fixture.customer.id,
          groupId: seededGroup.id,
          index: seedIndex,
          storeId: seededGroup.storeId,
        });
        seedIndex += 1;
      }
    }
    expect(seedIndex).toBe(101);

    await expect(
      uploadGroupFiles({
        customerId: fixture.customer.id,
        files: [file],
        groupId: group.id,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_FILE_LIMIT" });
  });

  test("serializes concurrent uploads so a group cannot race past 10 files", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    const file = await workbookFile();
    const sixFiles = (prefix: string) =>
      Array.from({ length: 6 }, (_, index) => ({
        ...file,
        fileName: `${prefix}-${index}.xlsx`,
      }));

    const results = await Promise.allSettled([
      uploadGroupFiles({
        customerId: fixture.customer.id,
        files: sixFiles("first"),
        groupId: group.id,
      }),
      uploadGroupFiles({
        customerId: fixture.customer.id,
        files: sixFiles("second"),
        groupId: group.id,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "GROUP_FILE_LIMIT" });
    expect(
      (await getBulkDraft(fixture.customer.id, draft.id)).groups[0].files,
    ).toHaveLength(6);
  });

  test("blocks uploads when an existing group's store is later disabled", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    await db
      .update(stores)
      .set({ status: "DISABLED" })
      .where(eq(stores.id, fixture.store.id));

    await expect(
      uploadGroupFiles({
        customerId: fixture.customer.id,
        files: [await workbookFile()],
        groupId: group.id,
      }),
    ).rejects.toMatchObject({ code: "STORE_DISABLED" });
    expect(
      await db
        .select({ id: orderImportBatches.id })
        .from(orderImportBatches)
        .where(eq(orderImportBatches.storeGroupId, group.id)),
    ).toEqual([]);
  });

  test("validates xlsx MIME, extension, 10 MB size, exact headers and 50,000-row limit", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    const valid = await workbookFile();
    const wrongHeaders = await workbookFile();
    const wrongHeaderWorkbook = new ExcelJS.Workbook();
    const wrongHeaderSheet = wrongHeaderWorkbook.addWorksheet("sheet1");
    wrongHeaderSheet.addRow(["错误表头"]);
    wrongHeaderSheet.addRow(["data"]);
    wrongHeaders.buffer = Buffer.from(await wrongHeaderWorkbook.xlsx.writeBuffer());

    const invalidFiles: Array<{
      code: string;
      file: BulkDraftUploadFile;
    }> = [
      {
        code: "INVALID_FILE_TYPE",
        file: { ...valid, fileName: "orders.xls" },
      },
      {
        code: "INVALID_FILE_TYPE",
        file: { ...valid, mimeType: "application/octet-stream" },
      },
      {
        code: "FILE_TOO_LARGE",
        file: { ...valid, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
      },
      { code: "INVALID_HEADERS", file: wrongHeaders },
      { code: "TOO_MANY_ROWS", file: await tooManyRowsFile() },
    ];

    for (const invalid of invalidFiles) {
      await expect(
        uploadGroupFiles({
          customerId: fixture.customer.id,
          files: [invalid.file],
          groupId: group.id,
        }),
      ).rejects.toMatchObject({ code: invalid.code });
    }
  });

  test("reuses exact SKU mapping and PII encryption without leaking recipient data to audit", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    const uploaded = await uploadGroupFiles({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
      files: [await workbookFile()],
      groupId: group.id,
    });

    expect(uploaded.files).toHaveLength(1);
    expect(uploaded.files[0]).toMatchObject({
      fileName: "TEMU-orders.xlsx",
      summary: { duplicate: 0, invalid: 0, ready: 1, total: 1, unknownSku: 0 },
    });
    const [storedRow] = await db
      .select()
      .from(orderImportRows)
      .where(eq(orderImportRows.batchId, uploaded.files[0].batchId));
    expect(storedRow.resolvedSkuId).toBe(fixture.sku.id);
    expect(storedRow.recipientPayloadEncrypted).not.toContain("Bulk Recipient");
    expect(
      decryptPii<{ name: string }>(storedRow.recipientPayloadEncrypted ?? "").name,
    ).toBe("Bulk Recipient");

    const logs = await db.select().from(auditLogs);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("Bulk Recipient");
    expect(serializedLogs).not.toContain("+1 416 555 0100");
    expect(serializedLogs).not.toContain("100 Private Avenue");
  });

  test("expired drafts remain readable as EXPIRED but reject group, upload and removal writes", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    const uploaded = await uploadGroupFiles({
      customerId: fixture.customer.id,
      files: [await workbookFile()],
      groupId: group.id,
    });
    await db
      .update(bulkImportDrafts)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(bulkImportDrafts.id, draft.id));

    await expect(
      getBulkDraft(fixture.customer.id, draft.id),
    ).resolves.toMatchObject({ status: "EXPIRED" });
    await expect(
      addStoreGroup({
        customerId: fixture.customer.id,
        draftId: draft.id,
        storeId: fixture.disabledStore.id,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_EXPIRED" });
    await expect(
      uploadGroupFiles({
        customerId: fixture.customer.id,
        files: [await workbookFile()],
        groupId: group.id,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_EXPIRED" });
    await expect(
      removeGroupFile({
        batchId: uploaded.files[0].batchId,
        customerId: fixture.customer.id,
      }),
    ).rejects.toMatchObject({ code: "DRAFT_EXPIRED" });
  });

  test("removes only a file owned by the requesting customer's group", async () => {
    const fixture = await createFixture();
    const draft = await createBulkDraft({
      actorUserId: "auth-customer-1",
      customerId: fixture.customer.id,
    });
    const group = await addStoreGroup({
      customerId: fixture.customer.id,
      draftId: draft.id,
      storeId: fixture.store.id,
    });
    const uploaded = await uploadGroupFiles({
      customerId: fixture.customer.id,
      files: [await workbookFile()],
      groupId: group.id,
    });
    const batchId = uploaded.files[0].batchId;

    await expect(
      removeGroupFile({ customerId: fixture.otherCustomer.id, batchId }),
    ).rejects.toMatchObject({ code: "GROUP_FILE_NOT_FOUND" });
    await removeGroupFile({ customerId: fixture.customer.id, batchId });
    await expect(
      db
        .select({ id: orderImportBatches.id })
        .from(orderImportBatches)
        .where(
          and(
            eq(orderImportBatches.id, batchId),
            eq(orderImportBatches.customerId, fixture.customer.id),
          ),
        ),
    ).resolves.toEqual([]);
    expect(
      (await getBulkDraft(fixture.customer.id, draft.id)).groups[0].files,
    ).toEqual([]);
  });
});
