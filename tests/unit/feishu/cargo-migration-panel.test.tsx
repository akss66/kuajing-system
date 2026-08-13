// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
    createCargoPreflightAction: idleAction,
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
        skuCount: 74,
        totalQuantity: 428,
      },
      updatedAtLabel: "2026/08/13 14:12",
      warningIssueCount: 1,
    },
    readOnlyConnectionMessage:
      "已验证源货盘和目标测试表配置，所有写入仍只会发送到目标测试表。",
    retryFeishuCargoSyncAction: idleAction,
    selectedSourceSheetId: null,
    sourceConfigured: true,
    sourceSheetDiscoveryMessage: null,
    sourceSheetDiscoveryStatus: "ready",
    sourceSheetOptions: [],
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

    expect(screen.getByText("原业务货盘受保护，系统不会写入。")).toBeVisible();
    expect(screen.getByRole("button", { name: "验证只读连接" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重新同步目标测试表" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "源工作表" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择源工作表后开始只读预检" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认迁移 74 个SKU" }),
    ).not.toBeInTheDocument();
  });

  it("shows immediate multi-sheet selection for super admins before preflight can start", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
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
    render(<CargoMigrationPanel {...createProps()} />);

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
});
