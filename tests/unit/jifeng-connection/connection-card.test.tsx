// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  diagnostic: vi.fn(),
  disconnect: vi.fn(),
  discover: vi.fn(),
  select: vi.fn(),
  setFulfillment: vi.fn(),
}));

const discoveryHook = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
}));

const authorizationHook = vi.hoisted(() => ({
  state: { status: "idle" } as Record<string, unknown>,
}));

const pageMocks = vi.hoisted(() => {
  const recentQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  recentQuery.from = vi.fn(() => recentQuery);
  recentQuery.where = vi.fn(() => recentQuery);
  recentQuery.orderBy = vi.fn(() => recentQuery);
  recentQuery.limit = vi.fn().mockResolvedValue([]);
  return {
    discoverFeishuSourceSheets: vi.fn(),
    findLatestImportedCargoRefreshBaseline: vi.fn(),
    getAdminView: vi.fn(),
    getLatestCatalogFieldRefreshState: vi.fn(),
    getLatestCargoMigrationRun: vi.fn(),
    getLatestCargoTargetSyncState: vi.fn(),
    getPublicStatus: vi.fn(),
    inspectConfiguration: vi.fn(),
    recentQuery,
    requireAdmin: vi.fn(),
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: vi.fn((action, initialState) => [
      action === actionMocks.discover
        ? discoveryHook.state
        : action === actionMocks.authorize
          ? authorizationHook.state
          : initialState,
      vi.fn(),
      false,
    ]),
  };
});

vi.mock("@/modules/jifeng-connection/actions", () => ({
  authorizeJifengConnectionAction: actionMocks.authorize,
  disconnectJifengConnectionAction: actionMocks.disconnect,
  discoverJifengResourcesAction: actionMocks.discover,
  runJifengDiagnosticAction: actionMocks.diagnostic,
  selectJifengResourcesAction: actionMocks.select,
  setJifengFulfillmentAction: actionMocks.setFulfillment,
}));

vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: pageMocks.requireAdmin,
}));
vi.mock("@/modules/jifeng-connection/queries", () => ({
  getJifengConnectionAdminView: pageMocks.getAdminView,
  getJifengConnectionPublicStatus: pageMocks.getPublicStatus,
}));
vi.mock("@/integrations/jifeng/config", () => ({
  inspectJifengConfiguration: pageMocks.inspectConfiguration,
}));
vi.mock("@/db/client", () => ({
  db: { select: vi.fn(() => pageMocks.recentQuery) },
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, desc: vi.fn(), eq: vi.fn() };
});
vi.mock("@/modules/feishu/actions", () => ({
  confirmCargoMigrationAction: vi.fn(),
  createCargoPreflightAction: vi.fn(),
  retryFeishuCargoSyncAction: vi.fn(),
  syncFeishuCatalogFieldsAction: vi.fn(),
  testFeishuConnectionAction: vi.fn(),
}));
vi.mock("@/modules/feishu/queries", () => ({
  findLatestImportedCargoRefreshBaseline:
    pageMocks.findLatestImportedCargoRefreshBaseline,
  getLatestCatalogFieldRefreshState:
    pageMocks.getLatestCatalogFieldRefreshState,
  getLatestCargoMigrationRun: pageMocks.getLatestCargoMigrationRun,
  getLatestCargoTargetSyncState: pageMocks.getLatestCargoTargetSyncState,
}));
vi.mock("@/modules/feishu/source-reader", () => ({
  discoverFeishuSourceSheets: pageMocks.discoverFeishuSourceSheets,
}));

import { JifengConnectionCard } from "@/components/integrations/jifeng-connection-card";
import IntegrationsPage from "@/app/(admin)/admin/system/integrations/page";
import type { JifengConnectionStatus } from "@/modules/jifeng-connection/types";

type CardConnection = React.ComponentProps<typeof JifengConnectionCard>["connection"];

function connection(status: JifengConnectionStatus): CardConnection {
  return {
    fulfillmentEnabled: status === "ENABLED",
    lastDiagnosticAt:
      status === "READY_DISABLED" || status === "ENABLED"
        ? new Date("2026-08-13T08:30:00.000Z")
        : null,
    status,
  };
}

const details = {
  authorizedAt: new Date("2026-08-12T08:00:00.000Z"),
  developerIdMasked: "de***-id",
  lastError: null,
  lastRefreshedAt: new Date("2026-08-13T08:00:00.000Z"),
  logistics: { id: 7, name: "加拿大邮政" },
  userIdMasked: "us***42",
  warehouse: { code: "CA-1", name: "加拿大一号仓" },
};

describe("JifengConnectionCard", () => {
  beforeEach(() => {
    discoveryHook.state = { status: "idle" };
    authorizationHook.state = { status: "idle" };
  });

  afterEach(() => cleanup());

  it.each([
    ["DISCONNECTED", "未连接", "不会向极风发送订单", "使用一次性令牌完成授权"],
    ["AUTHORIZED", "已授权，待发现资源", "自动履约保持关闭", "重新发现可用仓库和物流渠道"],
    ["RESOURCE_SELECTION_REQUIRED", "待选择履约资源", "不会默认选择任何仓库或渠道", "明确选择仓库和物流渠道"],
    ["READY_DISABLED", "已就绪，自动履约未启用", "订单仍留在本系统", "运行最新诊断并确认启用"],
    ["ENABLED", "自动履约已启用", "符合条件的已付款订单会自动推送", "异常时先停用自动履约"],
    ["REFRESH_REQUIRED", "授权需要更新", "自动推单已被阻止", "获取新的一次性令牌并重新授权"],
    ["ERROR", "连接异常", "当前连接不可用于履约", "重新授权；若仍失败请联系系统维护人员"],
  ] as const)(
    "explains the %s lifecycle state, consequence, and recovery",
    (status, label, consequence, nextStep) => {
      render(
        <JifengConnectionCard
          canManage
          connection={connection(status)}
          details={details}
        />,
      );

      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByText(consequence, { exact: false })).toBeVisible();
      expect(screen.getByText(nextStep, { exact: false })).toBeVisible();
    },
  );

  it("formats connection timestamps in the business timezone", () => {
    render(
      <JifengConnectionCard
        canManage
        connection={connection("READY_DISABLED")}
        details={details}
      />,
    );

    expect(screen.getByText("2026年8月12日 04:00")).toBeVisible();
    expect(screen.getByText("2026年8月13日 04:00")).toBeVisible();
  });

  it.each([
    [
      "DISCONNECTED",
      "不会向极风发送订单。",
      "使用一次性令牌完成授权。",
      "如需连接极风，请联系超级管理员完成授权。",
    ],
    [
      "AUTHORIZED",
      "自动履约保持关闭。",
      "重新发现可用仓库和物流渠道。",
      "请联系超级管理员发现并确认可用的履约资源。",
    ],
    [
      "RESOURCE_SELECTION_REQUIRED",
      "不会默认选择任何仓库或渠道。",
      "明确选择仓库和物流渠道。",
      "请联系超级管理员处理履约资源选择。",
    ],
    [
      "READY_DISABLED",
      "订单仍留在本系统，不会自动推送。",
      "运行最新诊断并确认启用。",
      "如需启用自动履约，请联系超级管理员完成诊断和确认。",
    ],
    [
      "ENABLED",
      "符合条件的已付款订单会自动推送到极风。",
      "异常时先停用自动履约，再检查连接。",
      "如需停用或检查连接，请联系超级管理员处理。",
    ],
    [
      "REFRESH_REQUIRED",
      "自动推单已被阻止。",
      "获取新的一次性令牌并重新授权。",
      "请联系超级管理员更新极风授权。",
    ],
    [
      "ERROR",
      "当前连接不可用于履约。",
      "重新授权；若仍失败请联系系统维护人员。",
      "请联系超级管理员重新授权或协调系统维护人员处理。",
    ],
  ] as const)(
    "gives an ordinary admin role-aware read-only recovery for %s",
    (status, consequence, forbiddenGuidance, recovery) => {
      render(
        <JifengConnectionCard
          canManage={false}
          connection={connection(status)}
        />,
      );

      expect(screen.getByText(consequence, { exact: false })).toBeVisible();
      expect(screen.getByText(recovery, { exact: false })).toBeVisible();
      expect(screen.queryByText(forbiddenGuidance, { exact: false })).not.toBeInTheDocument();
      expect(screen.getByRole("note", { name: "极风连接权限说明" })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByText("de***-id")).not.toBeInTheDocument();

      cleanup();
    },
  );

  it("renders a super-admin authorization form without retaining the one-time token", () => {
    const card = () => (
      <JifengConnectionCard
        canManage
        connection={connection("DISCONNECTED")}
        details={{ ...details, authorizedAt: null, lastRefreshedAt: null }}
      />
    );
    const { rerender } = render(card());

    expect(screen.getByLabelText("极风授权邮箱")).toHaveAttribute("type", "email");
    const token = screen.getByLabelText("一次性令牌") as HTMLInputElement;
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAttribute("autocomplete", "one-time-code");
    expect(token).not.toHaveAttribute("value");
    expect(token).not.toHaveAttribute("defaultValue");
    expect(screen.getByRole("button", { name: "完成极风授权" })).toBeEnabled();

    fireEvent.change(token, { target: { value: "one-time-token-1234" } });
    authorizationHook.state = {
      fieldErrors: { email: ["请输入有效的授权邮箱。"] },
      status: "error",
    };
    rerender(card());
    expect(token).toHaveValue("");
  });

  it("masks identifiers and wraps long safe operational text without rendering secrets", () => {
    const longName = `加拿大仓库${"很长".repeat(80)}`;
    render(
      <JifengConnectionCard
        canManage
        connection={connection("READY_DISABLED")}
        details={{
          ...details,
          warehouse: { code: "CA-LONG", name: longName },
        }}
      />,
    );

    expect(screen.getByText("de***-id")).toBeVisible();
    expect(screen.getByText("us***42")).toBeVisible();
    expect(screen.getByText(longName)).toHaveClass("break-words");
    expect(document.body.textContent).not.toMatch(/developer-secret|access-token|refresh-token/i);
  });

  it("requires explicit warehouse and logistics selection after ambiguous discovery", () => {
    discoveryHook.state = {
      message: "资源已更新，请明确选择仓库和物流渠道。",
      resources: {
        logistics: [
          { id: 7, name: "加拿大邮政 A" },
          { id: 8, name: "加拿大邮政 B" },
        ],
        warehouses: [
          { code: "CA-1", name: "加拿大一号仓" },
          { code: "CA-2", name: "加拿大二号仓" },
        ],
      },
      status: "success",
    };

    render(
      <JifengConnectionCard
        canManage
        connection={connection("RESOURCE_SELECTION_REQUIRED")}
        details={details}
      />,
    );

    const warehouse = screen.getByLabelText("选择极风仓库");
    const logistics = screen.getByLabelText("选择物流渠道");
    expect(warehouse).toBeRequired();
    expect(logistics).toBeRequired();
    expect(warehouse).toHaveValue("");
    expect(logistics).toHaveValue("");
    expect(within(warehouse).getByRole("option", { name: "请选择仓库" })).toHaveValue("");
    expect(
      within(logistics).getByRole("option", { name: "请选择物流渠道" }),
    ).toHaveValue("");
    expect(screen.getByRole("button", { name: "确认履约资源" })).toBeEnabled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("states the production consequence before enabling automatic fulfillment", () => {
    render(
      <JifengConnectionCard
        canManage
        connection={connection("READY_DISABLED")}
        details={details}
      />,
    );

    expect(screen.getByLabelText("启用原因")).toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "启用自动履约" }));

    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("确认启用极风自动履约？")).toBeVisible();
    expect(
      screen.getByText("启用后，符合条件的已付款订单会自动发送到极风并进入真实仓库履约。"),
    ).toBeVisible();
  });

  it("requires a reason and destructive confirmation before disconnecting", () => {
    render(
      <JifengConnectionCard
        canManage
        connection={connection("ENABLED")}
        details={details}
      />,
    );

    expect(screen.getByLabelText("断开原因")).toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "断开极风连接" }));

    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("确认断开极风连接？")).toBeVisible();
    expect(
      screen.getByText("系统会先停用自动履约，再清除已保存的授权凭证和资源选择；历史订单与审计记录不会删除。"),
    ).toBeVisible();
  });

  it("requires a reason when disabling fulfillment", () => {
    render(
      <JifengConnectionCard
        canManage
        connection={connection("ENABLED")}
        details={details}
      />,
    );

    expect(screen.getByLabelText("停用原因")).toBeRequired();
    expect(screen.getByRole("button", { name: "停用自动履约" })).toBeEnabled();
  });
});

describe("IntegrationsPage Jifeng connection assembly", () => {
  beforeEach(() => {
    process.env.JIFENG_CLIENT_ID = "developer-identifier-9876";
    pageMocks.requireAdmin.mockReset();
    pageMocks.getAdminView.mockReset();
    pageMocks.getPublicStatus.mockReset();
    pageMocks.inspectConfiguration.mockReset();
    pageMocks.discoverFeishuSourceSheets.mockReset();
    pageMocks.findLatestImportedCargoRefreshBaseline.mockReset();
    pageMocks.getLatestCatalogFieldRefreshState.mockReset();
    pageMocks.getLatestCargoMigrationRun.mockReset();
    pageMocks.getLatestCargoTargetSyncState.mockReset();
    pageMocks.recentQuery.limit.mockClear();
    pageMocks.inspectConfiguration.mockReturnValue({
      developer: { configured: true, invalidFields: [], missingFields: [] },
      level: "DEVELOPER_ONLY",
    });
    pageMocks.discoverFeishuSourceSheets.mockResolvedValue({
      message: "已读取源工作表",
      sheetOptions: [
        { index: 0, sheetId: "source-sheet-a", title: "货盘" },
      ],
      status: "READY",
    });
    pageMocks.findLatestImportedCargoRefreshBaseline.mockResolvedValue(null);
    pageMocks.getLatestCatalogFieldRefreshState.mockResolvedValue({
      lastUpdatedLabel: null,
    });
    pageMocks.getLatestCargoMigrationRun.mockResolvedValue(null);
    pageMocks.getLatestCargoTargetSyncState.mockResolvedValue({
      canRetry: false,
      imageCount: null,
      lastErrorMessage: null,
      lastUpdatedLabel: null,
      rowCount: null,
      statusLabel: "等待配置",
      targetSheetId: null,
      tone: "default",
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("loads the redacted admin projection and controls for a super admin", async () => {
    pageMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-user",
    });
    pageMocks.getAdminView.mockResolvedValue({
      ...connection("READY_DISABLED"),
      authorizedAt: details.authorizedAt,
      authorizedByAdminUserId: "raw-admin-identifier",
      fulfillmentEnabledAt: null,
      lastError: null,
      lastRefreshedAt: details.lastRefreshedAt,
      logistics: details.logistics,
      userIdMasked: details.userIdMasked,
      warehouse: details.warehouse,
    });

    render(await IntegrationsPage());

    expect(pageMocks.getAdminView).toHaveBeenCalledOnce();
    expect(pageMocks.getPublicStatus).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "集成运行状态" }),
    ).toBeVisible();
    expect(document.querySelector("[data-metric-strip]")).toBeNull();
    expect(screen.getByText("de***76")).toBeVisible();
    expect(screen.getByText("us***42")).toBeVisible();
    expect(screen.getByRole("button", { name: "运行只读诊断" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "管理飞书" }));
    const feishuDrawer = screen.getByRole("dialog", { name: "管理飞书集成" });
    expect(feishuDrawer).toBeVisible();
    expect(
      within(feishuDrawer).getByRole("button", { name: "验证只读连接" }),
    ).toBeEnabled();
    expect(document.body.textContent).not.toContain("developer-identifier-9876");
    expect(document.body.textContent).not.toContain("raw-admin-identifier");
  });

  it("loads only the public projection for an ordinary admin", async () => {
    pageMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "ordinary-admin-user",
    });
    pageMocks.getPublicStatus.mockResolvedValue(connection("ENABLED"));

    render(await IntegrationsPage());

    expect(pageMocks.getPublicStatus).toHaveBeenCalledOnce();
    expect(pageMocks.getAdminView).not.toHaveBeenCalled();
    expect(screen.getByText("只读状态")).toBeVisible();
    expect(screen.queryByRole("button", { name: "停用自动履约" })).not.toBeInTheDocument();
    expect(screen.queryByText("de***76")).not.toBeInTheDocument();
  });

  it("does not rediscover Feishu source sheets after the imported baseline exists", async () => {
    vi.stubEnv("FEISHU_APP_ID", "app-id");
    vi.stubEnv("FEISHU_APP_SECRET", "app-secret");
    vi.stubEnv("FEISHU_CARGO_SOURCE_WIKI_TOKEN", "wiki-token");
    pageMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-user",
    });
    pageMocks.getAdminView.mockResolvedValue(connection("READY_DISABLED"));
    pageMocks.findLatestImportedCargoRefreshBaseline.mockResolvedValue({
      cargoPricePlaceholders: [],
      expectedSkuCount: 147,
      expectedSourceSequenceCount: 83,
      importedAtLabel: "2026/08/14 06:43",
      sourceSheetId: "source-sheet-a",
      updatedAtLabel: "2026/08/14 06:43",
    });

    render(await IntegrationsPage());

    expect(pageMocks.discoverFeishuSourceSheets).not.toHaveBeenCalled();
  });

  it("still discovers Feishu source sheets before the imported baseline exists", async () => {
    vi.stubEnv("FEISHU_APP_ID", "app-id");
    vi.stubEnv("FEISHU_APP_SECRET", "app-secret");
    vi.stubEnv("FEISHU_CARGO_SOURCE_WIKI_TOKEN", "wiki-token");
    pageMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-user",
    });
    pageMocks.getAdminView.mockResolvedValue(connection("READY_DISABLED"));

    render(await IntegrationsPage());

    expect(pageMocks.discoverFeishuSourceSheets).toHaveBeenCalledOnce();
  });
});
