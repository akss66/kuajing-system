import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bossMocks = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  instances: [] as Array<{ connectionString: string }>,
  on: vi.fn(),
  schedule: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  work: vi.fn(async () => undefined),
}));

const configMocks = vi.hoisted(() => ({
  canProcessFeishuBot: vi.fn(),
  canWriteFeishuCargo: vi.fn(),
  hasFeishuRuntimeConfiguration: vi.fn(),
  readFeishuApiBaseUrl: vi.fn(),
  readFeishuConfig: vi.fn(),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class MockPgBoss {
    constructor(connectionString: string) {
      bossMocks.instances.push({ connectionString });
    }

    createQueue = bossMocks.createQueue;
    on = bossMocks.on;
    schedule = bossMocks.schedule;
    start = bossMocks.start;
    stop = bossMocks.stop;
    work = bossMocks.work;
  },
}));

vi.mock("@/integrations/feishu/client", () => ({
  FeishuClient: vi.fn(function FeishuClient() {
    return {};
  }),
}));

vi.mock("@/integrations/jifeng/client", () => ({
  JifengClient: vi.fn(function JifengClient() {
    return {};
  }),
}));

vi.mock("@/integrations/jifeng/config", () => ({
  readJifengConfig: vi.fn(),
}));

vi.mock("@/modules/fulfillment/dispatch", () => ({
  enqueuePaidOrdersForFulfillment: vi.fn(async () => 0),
  processDueJifengCreateOrderEvents: vi.fn(async () => ({
    completed: 0,
    failed: 0,
    retryScheduled: 0,
  })),
}));

vi.mock("@/modules/fulfillment/status-sync", () => ({
  pollActiveJifengFulfillments: vi.fn(async () => ({
    exceptions: 0,
    shipped: 0,
  })),
}));

vi.mock("@/modules/feishu/outbox", () => ({
  enqueueFeishuCargoSync: vi.fn(async () => false),
  processFeishuOutbox: vi.fn(async () => ({
    botCompleted: 0,
    cargoCompleted: 0,
    failed: 0,
  })),
}));

vi.mock("@/modules/orders/lifecycle", () => ({
  expirePendingPaymentOrders: vi.fn(async () => 0),
}));

vi.mock("@/modules/reports/stock-coverage", () => ({
  createDailyStockCoverageAlerts: vi.fn(async () => 0),
}));

vi.mock("@/modules/settlement/batch-service", () => ({
  expireSettlementBatches: vi.fn(async () => 0),
}));

vi.mock("@/shared/privacy", () => ({
  safeLogError: vi.fn((error: unknown) => error),
}));

vi.mock("@/integrations/feishu/config", async () => {
  const actual =
    await vi.importActual<typeof import("@/integrations/feishu/config")>(
      "@/integrations/feishu/config",
    );

  configMocks.hasFeishuRuntimeConfiguration.mockImplementation(
    actual.hasFeishuRuntimeConfiguration,
  );
  configMocks.readFeishuConfig.mockImplementation(actual.readFeishuConfig);
  configMocks.readFeishuApiBaseUrl.mockImplementation(actual.readFeishuApiBaseUrl);
  configMocks.canWriteFeishuCargo.mockImplementation(actual.canWriteFeishuCargo);
  configMocks.canProcessFeishuBot.mockImplementation(actual.canProcessFeishuBot);

  return {
    ...actual,
    canProcessFeishuBot: configMocks.canProcessFeishuBot,
    canWriteFeishuCargo: configMocks.canWriteFeishuCargo,
    hasFeishuRuntimeConfiguration: configMocks.hasFeishuRuntimeConfiguration,
    readFeishuApiBaseUrl: configMocks.readFeishuApiBaseUrl,
    readFeishuConfig: configMocks.readFeishuConfig,
  };
});

describe("worker Feishu bootstrap", () => {
  const originalEnv = { ...process.env };
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const replaceProcessEnv = (next: Record<string, string | undefined>) => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  };

  beforeEach(() => {
    vi.resetModules();
    bossMocks.createQueue.mockClear();
    bossMocks.instances.length = 0;
    bossMocks.on.mockClear();
    bossMocks.schedule.mockClear();
    bossMocks.start.mockClear();
    bossMocks.stop.mockClear();
    bossMocks.work.mockClear();
    configMocks.canProcessFeishuBot.mockClear();
    configMocks.canWriteFeishuCargo.mockClear();
    configMocks.hasFeishuRuntimeConfiguration.mockClear();
    configMocks.readFeishuApiBaseUrl.mockClear();
    configMocks.readFeishuConfig.mockClear();
    replaceProcessEnv({
      DATABASE_URL: "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test",
    });
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    replaceProcessEnv(originalEnv);
  });

  it("keeps Feishu jobs disabled when only the rollout gate is false", async () => {
    process.env.FEISHU_CARGO_WRITES_ENABLED = "false";

    await expect(import("@/jobs/worker")).resolves.toBeDefined();

    expect(configMocks.readFeishuConfig).not.toHaveBeenCalled();
    const queuedNames = (bossMocks.createQueue.mock.calls as unknown as string[][]).map(
      ([queueName]) => queueName,
    );
    expect(queuedNames).not.toContain("feishu-integration-cycle");
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "[worker] Feishu jobs disabled: credentials not configured",
    );
  });

  it("keeps Feishu jobs disabled when only the rollout gate is true", async () => {
    process.env.FEISHU_CARGO_WRITES_ENABLED = "true";

    await expect(import("@/jobs/worker")).resolves.toBeDefined();

    expect(configMocks.readFeishuConfig).not.toHaveBeenCalled();
    const queuedNames = (bossMocks.createQueue.mock.calls as unknown as string[][]).map(
      ([queueName]) => queueName,
    );
    expect(queuedNames).not.toContain("feishu-integration-cycle");
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "[worker] Feishu jobs disabled: credentials not configured",
    );
  });
});
