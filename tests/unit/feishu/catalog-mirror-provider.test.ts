import { beforeEach, describe, expect, it, vi } from "vitest";

const configMocks = vi.hoisted(() => ({
  canMirrorFeishuCatalog: vi.fn(),
  readFeishuApiBaseUrl: vi.fn(),
  readFeishuConfig: vi.fn(),
}));
const clientMocks = vi.hoisted(() => ({ client: { kind: "feishu-client" } }));
const constructorMocks = vi.hoisted(() => ({ FeishuClient: vi.fn() }));
const outboxMocks = vi.hoisted(() => ({ processCatalogMirrorOutbox: vi.fn() }));
const serviceMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  createCatalogFieldRefreshService: vi.fn(),
}));

vi.mock("@/integrations/feishu/config", () => configMocks);
vi.mock("@/integrations/feishu/client", () => constructorMocks);
vi.mock("@/modules/feishu/catalog-mirror-outbox", () => outboxMocks);
vi.mock("@/modules/feishu/catalog-field-refresh", () => ({
  createCatalogFieldRefreshService: serviceMocks.createCatalogFieldRefreshService,
}));

import { runFeishuCatalogMirrorCycle } from "@/modules/feishu/catalog-mirror-provider";

describe("Feishu catalog mirror provider", () => {
  beforeEach(() => {
    Object.values(configMocks).forEach((mock) => mock.mockReset());
    constructorMocks.FeishuClient.mockReset();
    outboxMocks.processCatalogMirrorOutbox.mockReset();
    serviceMocks.apply.mockReset();
    serviceMocks.createCatalogFieldRefreshService.mockReset();
    configMocks.canMirrorFeishuCatalog.mockReturnValue(true);
    configMocks.readFeishuApiBaseUrl.mockReturnValue("https://open.feishu.cn");
    configMocks.readFeishuConfig.mockReturnValue({
      appId: "app-id",
      appSecret: "app-secret",
      catalogMirrorEnabled: true,
      sourceWikiToken: "wiki-token",
    });
    constructorMocks.FeishuClient.mockImplementation(function FeishuClient() {
      return clientMocks.client;
    });
    serviceMocks.createCatalogFieldRefreshService.mockReturnValue({
      apply: serviceMocks.apply,
    });
    outboxMocks.processCatalogMirrorOutbox.mockImplementation(async ({ apply }) => {
      await apply({ actorUserId: "actor-1", sourceSheetId: "sheet-1" });
      return { completed: 1, failed: 0, processed: 1 };
    });
    serviceMocks.apply.mockResolvedValue({ skuCount: 140 });
  });

  it("runs queued mirrors with runtime credentials while keeping Feishu read-only", async () => {
    await expect(runFeishuCatalogMirrorCycle()).resolves.toEqual({
      completed: 1,
      enabled: true,
      failed: 0,
      processed: 1,
    });
    expect(serviceMocks.apply).toHaveBeenCalledWith({
      actorUserId: "actor-1",
      client: clientMocks.client,
      mode: "MIGRATION_MIRROR",
      reason: "后台执行迁移期飞书货盘全量镜像",
      sourceSheetId: "sheet-1",
      sourceWikiToken: "wiki-token",
    });
  });
});
