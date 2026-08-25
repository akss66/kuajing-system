// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigationMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigationMocks,
}));

import {
  CargoMigrationPanel,
  type CargoMigrationPanelProps,
} from "@/components/feishu/cargo-migration-panel";

async function idleAction() {
  return { status: "idle" as const };
}

function createRows() {
  return [
    {
      defaultUnitPriceLabel: "¥11.50",
      imageDigestLabel: "ab12cd34",
      imageStateLabel: "已暂存",
      inheritedFieldLabels: ["商品名称继承自第 2 行"],
      issueLabels: ["组合销售字段沿用上一行"],
      productGroupKey: "GROUP-001",
      productName: "探险杯套装",
      productUrl: "https://example.test/products/1",
      saleStatusLabel: "可售",
      skuCode: "SKU-001",
      skuName: "曜石黑",
      sourceRowNumber: 2,
      specification: "标准款",
      totalQuantity: 12,
      weightLabel: "218g",
    },
    {
      defaultUnitPriceLabel: "¥12.50",
      imageDigestLabel: "cd34ef56",
      imageStateLabel: "已暂存",
      inheritedFieldLabels: [],
      issueLabels: [],
      productGroupKey: "GROUP-002",
      productName: "旅行杯套装",
      productUrl: "https://example.test/products/2",
      saleStatusLabel: "可售",
      skuCode: "SKU-002",
      skuName: "云雾白",
      sourceRowNumber: 3,
      specification: "升级款",
      totalQuantity: 8,
      weightLabel: "205g",
    },
  ];
}

function createProps(
  overrides?: Partial<CargoMigrationPanelProps>,
): CargoMigrationPanelProps {
  return {
    actorKind: "SUPER_ADMIN",
    cargoImportEnabled: true,
    catalogMirrorCutoffLabel: "2026年9月1日 00:00",
    catalogMirrorEnabled: true,
    catalogMirrorPhase: "TRANSITION",
    catalogMirrorTaskState: {
      isActive: false,
      lastUpdatedLabel: null,
      result: null,
      safeErrorMessage: null,
      statusLabel: "尚未执行",
      tone: "default",
    },
    createCargoPreflightAction: idleAction,
    importedCargoBaseline: {
      importedAtLabel: "2026/08/13 14:12",
      updatedAtLabel: "2026/08/13 14:12",
    },
    latestMigrationRun: {
      blockingIssueCount: 0,
      createdAtLabel: "2026/08/13 14:10",
      hashSafeSourceDigest: "9d31b9f2",
      hashSafeSourceSpreadsheet: "1ea8b1d0",
      id: "run-ready",
      imageStateLabel: "已暂存",
      importedAtLabel: null,
      issueCount: 1,
      rows: createRows(),
      sourceRevision: 112,
      sourceSheetId: "sheet-source-a",
      status: "PREFLIGHT_READY",
      statusLabel: "预检就绪",
      statusTone: "success",
      summary: {
        imageCount: 74,
        productCount: 50,
        sourceSequenceCount: 50,
        skuCount: 74,
        totalQuantity: 428,
      },
      updatedAtLabel: "2026/08/13 14:12",
      warningIssueCount: 1,
    },
    readOnlyConnectionMessage:
      "已验证源货盘和目标测试表配置，所有写入仍只会发送到目标测试表。",
    latestCatalogRefreshLabel: "2026/08/20 15:30",
    cargoWritesEnabled: true,
    retryFeishuCargoSyncAction: idleAction,
    selectedSourceSheetId: null,
    sourceConfigured: true,
    sourceSheetDiscoveryMessage: null,
    sourceSheetDiscoveryStatus: "ready",
    sourceSheetOptions: [],
    syncFeishuCatalogFieldsAction: idleAction,
    targetConfigured: true,
    targetSyncState: {
      canRetry: false,
      imageCount: 74,
      lastErrorMessage: null,
      lastUpdatedLabel: "2026/08/13 14:20",
      rowCount: 74,
      statusLabel: "同步完成",
      targetSheetId: "target-sheet-a",
      tone: "success",
    },
    testFeishuConnectionAction: idleAction,
    ...overrides,
  };
}

describe("CargoMigrationPanel", () => {
  afterEach(() => {
    cleanup();
    navigationMocks.refresh.mockReset();
  });

  it("shows an ordinary admin the status view without discovery or first-import controls", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          actorKind: "ADMIN",
          sourceSheetOptions: [
            { index: 0, sheetId: "sheet-source-a", title: "货盘 A" },
            { index: 1, sheetId: "sheet-source-b", title: "货盘 B" },
          ],
        })}
      />,
    );

    expect(screen.getByText(/飞书源货盘始终只读/)).toBeVisible();
    expect(screen.getByRole("button", { name: "验证只读连接" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重新同步目标测试表" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "源工作表" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择源工作表后开始只读预检" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认迁移 74 个SKU" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "一键同步飞书货盘" }),
    ).not.toBeInTheDocument();
  });

  it("offers super admins a temporary full mirror after an imported baseline exists", () => {
    const props = createProps();
    render(
      <CargoMigrationPanel
        {...props}
        latestMigrationRun={{
          ...props.latestMigrationRun!,
          importedAtLabel: "2026/08/13 14:12",
          status: "IMPORTED",
          statusLabel: "已导入",
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "一键同步飞书货盘" }),
    ).toBeEnabled();
    expect(screen.getByText(/已有 SKU 的库存也会按飞书覆盖/)).toBeVisible();
    expect(screen.getByText(/飞书新增的 SKU 会同步创建/)).toBeVisible();
    expect(screen.getByText(/空字段会保留为空/)).toBeVisible();
    expect(screen.getByText(/资料不完整的 SKU 会强制保持不可售/)).toBeVisible();
    expect(screen.getByText(/飞书缺失的 SKU 会归档并清零/)).toBeVisible();
    expect(screen.getByText(/不会写入飞书/)).toBeVisible();
    expect(
      screen.getAllByText(/2026年9月1日 00:00 自动关闭/),
    ).toHaveLength(2);
    expect(screen.getByText("最近同步：2026/08/20 15:30")).toBeVisible();
    expect(screen.getByText("首批导入时间：2026/08/13 14:12")).toBeVisible();
    expect(
      screen.getByText("首批迁移记录更新：2026/08/13 14:12"),
    ).toBeVisible();
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("hides the temporary mirror after the rollout flag is disabled", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          catalogMirrorEnabled: false,
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "一键同步飞书货盘" }),
    ).not.toBeInTheDocument();
  });

  it("shows system takeover and hides mirror controls after the cutoff", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          catalogMirrorEnabled: false,
          catalogMirrorPhase: "RETIRED",
        })}
      />,
    );

    expect(screen.getByText(/飞书货盘镜像已于北京时间/)).toBeVisible();
    expect(screen.getByText(/系统货盘现已接管/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "一键同步飞书货盘" }),
    ).not.toBeInTheDocument();
  });

  it("fails closed when the mirror cutoff is missing or invalid", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          catalogMirrorCutoffLabel: null,
          catalogMirrorEnabled: false,
          catalogMirrorPhase: "MISCONFIGURED",
        })}
      />,
    );

    expect(screen.getByText(/缺少有效截止时间/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "一键同步飞书货盘" }),
    ).not.toBeInTheDocument();
  });

  it("hides one-click catalog sync until an imported baseline exists", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          importedCargoBaseline: null,
          latestCatalogRefreshLabel: null,
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "一键同步飞书货盘" }),
    ).not.toBeInTheDocument();
  });

  it("keeps first-import controls closed when a newer preflight exists after import", () => {
    const props = createProps();
    render(
      <CargoMigrationPanel
        {...props}
        latestCatalogRefreshLabel="2026/08/21 10:24"
        latestMigrationRun={{
          ...props.latestMigrationRun!,
          updatedAtLabel: "2026/08/20 16:00",
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "开始只读预检" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("首批导入时间：2026/08/13 14:12")).toBeVisible();
    expect(
      screen.getByText("首批迁移记录更新：2026/08/13 14:12"),
    ).toBeVisible();
    expect(screen.getByText("最近同步：2026/08/21 10:24")).toBeVisible();
    expect(
      screen.queryByText("首批迁移记录更新：2026/08/20 16:00"),
    ).not.toBeInTheDocument();
  });

  it("disables one-click catalog sync and announces progress while pending", async () => {
    let finishSync!: (state: { message: string; status: "success" }) => void;
    const syncAction = vi.fn(
      async () =>
        await new Promise<{ message: string; status: "success" }>((resolve) => {
          finishSync = resolve;
        }),
    );
    render(
      <CargoMigrationPanel
        {...createProps({ syncFeishuCatalogFieldsAction: syncAction })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "一键同步飞书货盘" }),
    );

    const pendingButton = await screen.findByRole("button", {
      name: "正在加入队列",
    });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      finishSync({ message: "同步完成", status: "success" });
    });
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
      "同步完成",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "一键同步飞书货盘" }),
      ).toBeEnabled(),
    );
    expect(navigationMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a durable background mirror visibly disabled across page refreshes", () => {
    render(
      <CargoMigrationPanel
        {...createProps()}
        catalogMirrorTaskState={{
          isActive: true,
          lastUpdatedLabel: "2026/08/24 10:00",
          result: null,
          safeErrorMessage: null,
          statusLabel: "同步中",
          tone: "warning",
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "后台同步中" }),
    ).toBeDisabled();
    expect(screen.getByText("任务状态：同步中")).toBeVisible();
    expect(screen.getByText("可以离开本页面，后台任务不会中断。")).toBeVisible();
  });

  it("shows immediate multi-sheet selection for super admins before preflight can start", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          importedCargoBaseline: null,
          latestMigrationRun: null,
          sourceSheetOptions: [
            { index: 0, sheetId: "sheet-source-a", title: "货盘 A" },
            { index: 1, sheetId: "sheet-source-b", title: "货盘 B" },
          ],
        })}
      />,
    );

    const picker = screen.getByRole("combobox", { name: "源工作表" });
    const preflightButton = screen.getByRole("button", {
      name: "选择源工作表后开始只读预检",
    });

    expect(picker).toBeVisible();
    expect(preflightButton).toBeDisabled();

    fireEvent.change(picker, { target: { value: "sheet-source-a" } });

    expect(
      screen.getByRole("button", { name: "开始只读预检" }),
    ).toBeEnabled();
  });

  it("prioritizes migration setup ahead of connection diagnostics for super admins before import", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          importedCargoBaseline: null,
          latestMigrationRun: null,
          sourceSheetOptions: [
            { index: 0, sheetId: "sheet-source-a", title: "货盘 A" },
            { index: 1, sheetId: "sheet-source-b", title: "货盘 B" },
          ],
        })}
      />,
    );

    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    const summaryIndex = headings.indexOf("迁移状态总览");
    const setupIndex = headings.indexOf("数据回填控制");
    const connectionIndex = headings.indexOf("连接与目标同步");
    const detailIndex = headings.indexOf("只读预检明细");

    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(summaryIndex);
    expect(connectionIndex).toBeGreaterThan(setupIndex);
    expect(detailIndex).toBeGreaterThan(connectionIndex);

    const setupPanel = screen
      .getByRole("heading", { name: "数据回填控制", level: 2 })
      .closest("section");
    expect(setupPanel).not.toBeNull();
    expect(within(setupPanel!).getByRole("combobox", { name: "源工作表" })).toBeVisible();
    expect(
      within(setupPanel!).getByRole("button", {
        name: "选择源工作表后开始只读预检",
      }),
    ).toBeVisible();
  });

  it("uses retry wording only when a failed target sync exists", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          targetSyncState: {
            canRetry: true,
            imageCount: 74,
            lastErrorMessage: "同步时网络超时",
            lastUpdatedLabel: "2026/08/13 14:20",
            rowCount: 74,
            statusLabel: "等待重试",
            targetSheetId: "target-sheet-a",
            tone: "warning",
          },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "重试目标同步" })).toBeVisible();
    expect(screen.getByText("最近失败原因：同步时网络超时")).toBeVisible();
  });

  it("keeps mobile review rows collapsed except for the first actionable issue", () => {
    render(<CargoMigrationPanel {...createProps()} />);

    const detailButtons = screen.getAllByRole("button", { name: /查看详情/ });
    expect(detailButtons).toHaveLength(2);
    expect(detailButtons[0]).toHaveAttribute("aria-expanded", "true");
    expect(detailButtons[1]).toHaveAttribute("aria-expanded", "false");

    const firstCard = detailButtons[0].closest("article");
    const secondCard = detailButtons[1].closest("article");
    expect(firstCard).not.toBeNull();
    expect(secondCard).not.toBeNull();

    expect(within(firstCard!).getByText("1 个问题")).toBeVisible();
    expect(within(secondCard!).getAllByText("无阻断问题")[0]).toBeVisible();

    fireEvent.click(detailButtons[1]);
    expect(detailButtons[1]).toHaveAttribute("aria-expanded", "true");
    expect(within(secondCard!).getByText("https://example.test/products/2")).toBeVisible();
  });

  it("unlocks confirmation only after the exact phrase is entered", async () => {
    render(
      <CargoMigrationPanel
        {...createProps({ importedCargoBaseline: null })}
      />,
    );

    expect(screen.getAllByText("探险杯套装").length).toBeGreaterThan(0);
    expect(screen.queryByText("file-token-SKU-001")).not.toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();

    const phraseInput = screen.getByLabelText("确认语句");
    const confirmButton = screen.getByRole("button", {
      name: "确认迁移 74 个SKU",
    });

    expect(confirmButton).toBeDisabled();

    fireEvent.change(phraseInput, {
      target: { value: "确认迁移73个SKU" },
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(phraseInput, {
      target: { value: "确认迁移74个SKU" },
    });
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    expect(
      await screen.findByRole("alertdialog", { name: "确认导入 74 个SKU" }),
    ).toBeVisible();
  });

  it("shows database-write semantics without offering disabled target-write controls", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          cargoImportEnabled: false,
          cargoWritesEnabled: false,
          importedCargoBaseline: null,
          selectedSourceSheetId: "sheet-source-a",
          targetConfigured: true,
        })}
      />,
    );

    expect(screen.getAllByText(/写入本系统数据库/).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "确认迁移 74 个SKU" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新同步目标测试表" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始只读预检" }),
    ).toBeEnabled();
    expect(screen.queryByText(/FEISHU_CARGO_WRITES_ENABLED/)).not.toBeInTheDocument();
  });
});
