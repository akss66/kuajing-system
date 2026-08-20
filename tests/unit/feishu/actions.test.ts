import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) =>
    callback({}),
  ),
}));

const guardMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSuperAdmin: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  canImportFeishuCargo: vi.fn(),
  canWriteFeishuCargo: vi.fn(),
  hasFeishuCargoTargetConfig: vi.fn(),
  readFeishuApiBaseUrl: vi.fn(),
  readFeishuConfig: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  applyCatalogFieldRefresh: vi.fn(),
  confirmCargoMigration: vi.fn(),
  createCatalogFieldRefreshService: vi.fn(),
  createCargoPreflight: vi.fn(),
  createFeishuCargoMigrationService: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  findCargoMigrationRunConfirmationSummary: vi.fn(),
  findLatestImportedCargoRefreshBaseline: vi.fn(),
}));

const outboxMocks = vi.hoisted(() => ({
  enqueueCargoSyncEvent: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  createFilter: vi.fn(),
  downloadMedia: vi.fn(),
  listSheets: vi.fn(),
  readRangeDetails: vi.fn(),
  resolveWikiSpreadsheet: vi.fn(),
  setRangeStyle: vi.fn(),
  updateDimension: vi.fn(),
  updateSheetProperties: vi.fn(),
  writeImage: vi.fn(),
  writeRange: vi.fn(),
}));

const constructorMocks = vi.hoisted(() => ({
  FeishuClient: vi.fn(function FeishuClient() {
    return clientMocks;
  }),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/db/client", () => ({
  db: dbMocks,
}));
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/integrations/feishu/config", () => configMocks);
vi.mock("@/modules/feishu/migration-service", () => ({
  createFeishuCargoMigrationService:
    serviceMocks.createFeishuCargoMigrationService,
}));
vi.mock("@/modules/feishu/catalog-field-refresh", () => ({
  createCatalogFieldRefreshService:
    serviceMocks.createCatalogFieldRefreshService,
}));
vi.mock("@/modules/feishu/queries", () => ({
  findCargoMigrationRunConfirmationSummary:
    queryMocks.findCargoMigrationRunConfirmationSummary,
  findLatestImportedCargoRefreshBaseline:
    queryMocks.findLatestImportedCargoRefreshBaseline,
}));
vi.mock("@/modules/feishu/outbox", () => ({
  enqueueCargoSyncEvent: outboxMocks.enqueueCargoSyncEvent,
}));
vi.mock("@/integrations/feishu/client", () => constructorMocks);

import {
  confirmCargoMigrationAction,
  createCargoPreflightAction,
  retryFeishuCargoSyncAction,
  syncFeishuCatalogFieldsAction,
  testFeishuConnectionAction,
} from "@/modules/feishu/actions";

describe("feishu admin actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    dbMocks.transaction.mockClear();
    guardMocks.requireAdmin.mockReset();
    guardMocks.requireSuperAdmin.mockReset();
    configMocks.canWriteFeishuCargo.mockReset();
    configMocks.canImportFeishuCargo.mockReset();
    configMocks.hasFeishuCargoTargetConfig.mockReset();
    configMocks.readFeishuApiBaseUrl.mockReset();
    configMocks.readFeishuConfig.mockReset();
    serviceMocks.confirmCargoMigration.mockReset();
    serviceMocks.applyCatalogFieldRefresh.mockReset();
    serviceMocks.createCatalogFieldRefreshService.mockReset();
    serviceMocks.createCargoPreflight.mockReset();
    serviceMocks.createFeishuCargoMigrationService.mockReset();
    queryMocks.findCargoMigrationRunConfirmationSummary.mockReset();
    queryMocks.findLatestImportedCargoRefreshBaseline.mockReset();
    outboxMocks.enqueueCargoSyncEvent.mockReset();
    constructorMocks.FeishuClient.mockClear();
    Object.values(clientMocks).forEach((mock) => mock.mockReset());

    guardMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "admin-user-1",
    });
    guardMocks.requireSuperAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-user-1",
    });
    configMocks.canWriteFeishuCargo.mockReturnValue(true);
    configMocks.canImportFeishuCargo.mockReturnValue(true);
    configMocks.hasFeishuCargoTargetConfig.mockReturnValue(true);
    configMocks.readFeishuApiBaseUrl.mockReturnValue("http://127.0.0.1:4010");
    configMocks.readFeishuConfig.mockReturnValue({
      appId: "app-id",
      appSecret: "app-secret",
      cargoImportEnabled: true,
      cargoWritesEnabled: true,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source-token",
      targetSheetId: "target-sheet-id",
      targetSpreadsheetToken: "target-spreadsheet-token",
    });
    serviceMocks.createFeishuCargoMigrationService.mockReturnValue({
      confirmCargoMigration: serviceMocks.confirmCargoMigration,
      createCargoPreflight: serviceMocks.createCargoPreflight,
    });
    serviceMocks.createCatalogFieldRefreshService.mockReturnValue({
      apply: serviceMocks.applyCatalogFieldRefresh,
    });
    queryMocks.findLatestImportedCargoRefreshBaseline.mockResolvedValue({
      cargoPricePlaceholders: [
        { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
      ],
      expectedSkuCount: 140,
      expectedSourceSequenceCount: 74,
      sourceSheetId: "sheet-source-a",
    });
    queryMocks.findCargoMigrationRunConfirmationSummary.mockResolvedValue({
      blockingIssueCount: 0,
      runId: "run-74",
      skuCount: 74,
      status: "PREFLIGHT_READY",
    });
    clientMocks.resolveWikiSpreadsheet.mockResolvedValue({
      spreadsheetToken: "source-spreadsheet-token",
    });
    clientMocks.listSheets.mockResolvedValue([
      { index: 0, sheetId: "sheet-1", title: "Sheet 1" },
    ]);
  });

  it("returns source-sheet options when the first preflight requires an explicit selection", async () => {
    serviceMocks.createCargoPreflight.mockResolvedValue({
      sheetOptions: [
        { index: 0, sheetId: "sheet-a", title: "Cargo A" },
        { index: 1, sheetId: "sheet-b", title: "Cargo B" },
      ],
      status: "SOURCE_SHEET_SELECTION_REQUIRED",
    });

    const result = await createCargoPreflightAction({ status: "idle" }, new FormData());

    expect(result.availableSourceSheets).toEqual([
      { index: 0, sheetId: "sheet-a", title: "Cargo A" },
      { index: 1, sheetId: "sheet-b", title: "Cargo B" },
    ]);
    expect(result.status).toBe("error");
    expect(result.message).toContain("工");
    expect(serviceMocks.createCargoPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: "SUPER_ADMIN", userId: "super-admin-user-1" },
        config: expect.objectContaining({
          sourceSheetId: undefined,
          sourceWikiToken: "wiki-source-token",
        }),
      }),
    );
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a tampered client sku count and derives the phrase from the persisted run summary", async () => {
    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移1个SKU");
    formData.set("expectedSkuCount", "1");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.confirmationPhrase?.[0]).toContain("74");
    expect(result.fieldErrors?.confirmationPhrase?.[0]).not.toContain("1个SKU");
    expect(queryMocks.findCargoMigrationRunConfirmationSummary).toHaveBeenCalledWith(
      "run-74",
    );
    expect(serviceMocks.confirmCargoMigration).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("accepts the server-derived confirmation phrase even when the hidden client count is tampered", async () => {
    serviceMocks.confirmCargoMigration.mockResolvedValue({
      imageCount: 74,
      productCount: 50,
      skuCount: 74,
      sourceSequenceCount: 50,
      totalQuantity: 428,
    });

    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移74个SKU");
    formData.set("expectedSkuCount", "1");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result.status).toBe("success");
    expect(result.message).toContain("50");
    expect(result.message).toContain("74");
    expect(guardMocks.requireSuperAdmin).toHaveBeenCalledTimes(1);
    expect(serviceMocks.confirmCargoMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: "SUPER_ADMIN", userId: "super-admin-user-1" },
        runId: "run-74",
      }),
    );
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/system/integrations",
    );
  });

  it("replays an imported migration through the service when the rollout gate is off", async () => {
    configMocks.canImportFeishuCargo.mockReturnValue(false);
    configMocks.readFeishuConfig.mockReturnValue({
      appId: "app-id",
      appSecret: "app-secret",
      cargoImportEnabled: false,
      cargoWritesEnabled: false,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source-token",
      targetSheetId: undefined,
      targetSpreadsheetToken: undefined,
    });
    queryMocks.findCargoMigrationRunConfirmationSummary.mockResolvedValue({
      blockingIssueCount: 0,
      runId: "run-74",
      skuCount: 74,
      status: "IMPORTED",
    });
    serviceMocks.confirmCargoMigration.mockResolvedValue({
      imageCount: 74,
      productCount: 50,
      skuCount: 74,
      sourceSequenceCount: 50,
      totalQuantity: 428,
    });

    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移74个SKU");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result).toMatchObject({
      message: expect.stringContaining("50 个来源序号、74 个SKU"),
      status: "success",
    });
    expect(serviceMocks.confirmCargoMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ cargoImportEnabled: false }),
        runId: "run-74",
      }),
    );
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/system/integrations",
    );
  });

  it("still rejects a non-imported run that is not ready", async () => {
    queryMocks.findCargoMigrationRunConfirmationSummary.mockResolvedValue({
      blockingIssueCount: 1,
      runId: "run-74",
      skuCount: 74,
      status: "PREFLIGHT_BLOCKED",
    });

    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移74个SKU");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("不可确认");
    expect(serviceMocks.confirmCargoMigration).not.toHaveBeenCalled();
  });

  it("imports into PostgreSQL without a target sheet while Feishu writes stay disabled", async () => {
    configMocks.canImportFeishuCargo.mockReturnValue(true);
    configMocks.canWriteFeishuCargo.mockReturnValue(false);
    configMocks.hasFeishuCargoTargetConfig.mockReturnValue(false);
    configMocks.readFeishuConfig.mockReturnValue({
      appId: "app-id",
      appSecret: "app-secret",
      cargoImportEnabled: true,
      cargoWritesEnabled: false,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source-token",
      targetSheetId: undefined,
      targetSpreadsheetToken: undefined,
    });
    serviceMocks.confirmCargoMigration.mockResolvedValue({
      imageCount: 140,
      productCount: 74,
      skuCount: 140,
      sourceSequenceCount: 74,
      totalQuantity: 312,
    });

    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移74个SKU");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result).toMatchObject({
      message: expect.stringContaining("74 个来源序号、140 个SKU"),
      status: "success",
    });
    expect(serviceMocks.confirmCargoMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          cargoImportEnabled: true,
          cargoWritesEnabled: false,
        }),
      }),
    );
    expect(outboxMocks.enqueueCargoSyncEvent).not.toHaveBeenCalled();
  });

  it("returns an action error when the persisted run summary is unavailable", async () => {
    queryMocks.findCargoMigrationRunConfirmationSummary.mockResolvedValue(null);

    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移74个SKU");
    formData.set("runId", "missing-run");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result.message).toContain("预检");
    expect(serviceMocks.confirmCargoMigration).not.toHaveBeenCalled();
  });

  it("keeps confirmation read-only while the rollout gate is off even when the phrase is correct", async () => {
    configMocks.canImportFeishuCargo.mockReturnValue(false);
    configMocks.canWriteFeishuCargo.mockReturnValue(false);
    configMocks.hasFeishuCargoTargetConfig.mockReturnValue(true);
    configMocks.readFeishuConfig.mockReturnValue({
      appId: "app-id",
      appSecret: "app-secret",
      cargoImportEnabled: false,
      cargoWritesEnabled: false,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source-token",
      targetSheetId: "target-sheet-id",
      targetSpreadsheetToken: "target-spreadsheet-token",
    });

    const formData = new FormData();
    formData.set("confirmationPhrase", "纭杩佺Щ74涓猄KU");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result.message).toContain("只读");
    expect(queryMocks.findCargoMigrationRunConfirmationSummary).toHaveBeenCalledWith(
      "run-74",
    );
    expect(serviceMocks.confirmCargoMigration).not.toHaveBeenCalled();
  });

  it("keeps confirmation read-only while the rollout gate is off even when the phrase is tampered", async () => {
    configMocks.canImportFeishuCargo.mockReturnValue(false);
    configMocks.canWriteFeishuCargo.mockReturnValue(false);
    configMocks.hasFeishuCargoTargetConfig.mockReturnValue(true);
    configMocks.readFeishuConfig.mockReturnValue({
      appId: "app-id",
      appSecret: "app-secret",
      cargoImportEnabled: false,
      cargoWritesEnabled: false,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source-token",
      targetSheetId: "target-sheet-id",
      targetSpreadsheetToken: "target-spreadsheet-token",
    });

    const formData = new FormData();
    formData.set("confirmationPhrase", "纭杩佺Щ1涓猄KU");
    formData.set("expectedSkuCount", "1");
    formData.set("runId", "run-74");

    const result = await confirmCargoMigrationAction({ status: "idle" }, formData);

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result.message).toContain("只读");
    expect(queryMocks.findCargoMigrationRunConfirmationSummary).toHaveBeenCalledWith(
      "run-74",
    );
    expect(serviceMocks.confirmCargoMigration).not.toHaveBeenCalled();
  });

  it("keeps manual target sync unavailable when the target sheet is not configured", async () => {
    configMocks.canWriteFeishuCargo.mockReturnValue(false);
    configMocks.hasFeishuCargoTargetConfig.mockReturnValue(false);

    const result = await retryFeishuCargoSyncAction({ status: "idle" }, new FormData());

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result.message).toContain("目标");
    expect(outboxMocks.enqueueCargoSyncEvent).not.toHaveBeenCalled();
  });

  it("tests the source and target connection through read-only calls only", async () => {
    clientMocks.listSheets
      .mockResolvedValueOnce([
        { index: 0, sheetId: "sheet-source", title: "Source Sheet" },
      ])
      .mockResolvedValueOnce([
        { index: 0, sheetId: "sheet-target", title: "Target Sheet" },
      ]);

    const result = await testFeishuConnectionAction({ status: "idle" }, new FormData());

    expect(result).toMatchObject({
      status: "success",
    });
    expect(result.message).toContain("源");
    expect(clientMocks.resolveWikiSpreadsheet).toHaveBeenCalledWith(
      "wiki-source-token",
    );
    expect(clientMocks.listSheets).toHaveBeenNthCalledWith(
      1,
      "source-spreadsheet-token",
    );
    expect(clientMocks.listSheets).toHaveBeenNthCalledWith(
      2,
      "target-spreadsheet-token",
    );
    expect(clientMocks.writeRange).not.toHaveBeenCalled();
    expect(clientMocks.writeImage).not.toHaveBeenCalled();
    expect(clientMocks.setRangeStyle).not.toHaveBeenCalled();
    expect(clientMocks.updateDimension).not.toHaveBeenCalled();
    expect(clientMocks.createFilter).not.toHaveBeenCalled();
  });

  it("stops at the super-admin guard when an ordinary admin tries to confirm a migration", async () => {
    guardMocks.requireSuperAdmin.mockRejectedValue(new Error("FORBIDDEN_ADMIN"));

    const formData = new FormData();
    formData.set("confirmationPhrase", "确认迁移74个SKU");
    formData.set("expectedSkuCount", "74");
    formData.set("runId", "run-74");

    await expect(
      confirmCargoMigrationAction({ status: "idle" }, formData),
    ).rejects.toThrow("FORBIDDEN_ADMIN");
    expect(serviceMocks.confirmCargoMigration).not.toHaveBeenCalled();
  });

  it("stops before configuration, database, or Feishu access when catalog sync is unauthorized", async () => {
    guardMocks.requireSuperAdmin.mockRejectedValue(new Error("FORBIDDEN_ADMIN"));

    await expect(
      syncFeishuCatalogFieldsAction({ status: "idle" }, new FormData()),
    ).rejects.toThrow("FORBIDDEN_ADMIN");

    expect(configMocks.readFeishuConfig).not.toHaveBeenCalled();
    expect(queryMocks.findLatestImportedCargoRefreshBaseline).not.toHaveBeenCalled();
    expect(serviceMocks.createCatalogFieldRefreshService).not.toHaveBeenCalled();
    expect(constructorMocks.FeishuClient).not.toHaveBeenCalled();
  });

  it("synchronizes exact Feishu catalog rows without legacy counts or placeholders", async () => {
    serviceMocks.applyCatalogFieldRefresh.mockResolvedValue({
      cargoPricePlaceholders: [],
      createdProductCount: 2,
      createdSkuCount: 3,
      degradedSkuCount: 1,
      matchedSkuCount: 140,
      productsToMerge: 2,
      skuCount: 143,
      sourceSequenceCount: 76,
      warningCount: 7,
    });

    const result = await syncFeishuCatalogFieldsAction(
      { status: "idle" },
      new FormData(),
    );

    expect(result).toEqual({
      message: "飞书货盘同步完成：共 143 个 SKU；新增 3 个 SKU、2 个商品，更新 140 个 SKU；1 个资料不完整的 SKU 已保持不可售。已有库存未覆盖，新 SKU 已按飞书库存初始化。",
      status: "success",
    });
    expect(serviceMocks.applyCatalogFieldRefresh).toHaveBeenCalledWith({
      actorUserId: "super-admin-user-1",
      client: clientMocks,
      reason: "超级管理员一键同步飞书货盘商品字段",
      sourceSheetId: "sheet-source-a",
      sourceWikiToken: "wiki-source-token",
    });
    expect(clientMocks.writeRange).not.toHaveBeenCalled();
    expect(clientMocks.writeImage).not.toHaveBeenCalled();
    expect(clientMocks.setRangeStyle).not.toHaveBeenCalled();
    expect(clientMocks.updateDimension).not.toHaveBeenCalled();
    expect(clientMocks.updateSheetProperties).not.toHaveBeenCalled();
    expect(clientMocks.createFilter).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath.mock.calls).toEqual([
      ["/admin/system/integrations"],
      ["/admin/catalog"],
      ["/admin/inventory"],
    ]);
  });

  it("requires an imported baseline before reading configuration or calling Feishu", async () => {
    queryMocks.findLatestImportedCargoRefreshBaseline.mockResolvedValue(null);

    const result = await syncFeishuCatalogFieldsAction(
      { status: "idle" },
      new FormData(),
    );

    expect(result).toEqual({
      message: "尚无已导入的飞书货盘基线，请先完成首批导入。",
      status: "error",
    });
    expect(configMocks.readFeishuConfig).not.toHaveBeenCalled();
    expect(serviceMocks.applyCatalogFieldRefresh).not.toHaveBeenCalled();
    expect(constructorMocks.FeishuClient).not.toHaveBeenCalled();
  });

  it.each([
    ["PRODUCT_GROUPING_CONFLICT", "商品分组"],
    ["PARSER_BLOCKING_ISSUES", "阻断问题"],
    ["NO_SYNCABLE_SKUS", "有效 SKU"],
    ["SOURCE_IMAGE_DOWNLOAD_FAILED", "图片"],
  ])("maps catalog refresh failure %s to safe Chinese", async (code, label) => {
    serviceMocks.applyCatalogFieldRefresh.mockRejectedValue(new Error(code));

    const result = await syncFeishuCatalogFieldsAction(
      { status: "idle" },
      new FormData(),
    );

    expect(result.status).toBe("error");
    expect(result.message).toContain(label);
    expect(result.message).not.toContain(code);
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not expose third-party error codes or tokens from a failed refresh", async () => {
    serviceMocks.applyCatalogFieldRefresh.mockRejectedValue(
      new Error("FeishuApiError code=999 token=secret-value"),
    );

    const result = await syncFeishuCatalogFieldsAction(
      { status: "idle" },
      new FormData(),
    );

    expect(result).toEqual({
      message: "暂时无法读取飞书货盘，请稍后重试；本次未修改商品或库存。",
      status: "error",
    });
    expect(result.message).not.toContain("999");
    expect(result.message).not.toContain("secret-value");
  });

  it("does not expose database details when the imported baseline cannot be read", async () => {
    queryMocks.findLatestImportedCargoRefreshBaseline.mockRejectedValue(
      new Error("postgres password=secret-value relation=internal_table"),
    );

    const result = await syncFeishuCatalogFieldsAction(
      { status: "idle" },
      new FormData(),
    );

    expect(result).toEqual({
      message: "暂时无法读取飞书货盘，请稍后重试；本次未修改商品或库存。",
      status: "error",
    });
    expect(result.message).not.toContain("secret-value");
    expect(configMocks.readFeishuConfig).not.toHaveBeenCalled();
    expect(serviceMocks.applyCatalogFieldRefresh).not.toHaveBeenCalled();
  });
});
