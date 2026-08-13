// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CargoMigrationPanel,
  type CargoMigrationPanelProps,
} from "@/components/feishu/cargo-migration-panel";

async function idleAction() {
  return { status: "idle" as const };
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
      rows: [
        {
          defaultUnitPriceLabel: "¥11.50",
          imageDigestLabel: "ab12cd34",
          imageStateLabel: "已暂存",
          inheritedFieldLabels: ["名称继承自第 2 行"],
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
      ],
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
    sourceSheetOptions: [],
    targetConfigured: true,
    targetSyncState: {
      canRetry: true,
      lastErrorMessage: null,
      lastUpdatedLabel: "2026/08/13 14:20",
      rowCount: 74,
      imageCount: 74,
      statusLabel: "等待重试",
      targetSheetId: "target-sheet-a",
      tone: "warning",
    },
    testFeishuConnectionAction: idleAction,
    ...overrides,
  };
}

describe("CargoMigrationPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows an ordinary admin the status view without first-import controls", () => {
    render(
      <CargoMigrationPanel
        {...createProps({
          actorKind: "ADMIN",
        })}
      />,
    );

    expect(screen.getByText("原业务货盘受保护，系统不会写入。")).toBeVisible();
    expect(screen.getByRole("button", { name: "验证只读连接" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重试目标同步" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "开始只读预检" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认迁移 74 个 SKU" }),
    ).not.toBeInTheDocument();
  });

  it("lets a super admin inspect final preflight values and unlocks confirmation only after the exact phrase is entered", async () => {
    render(<CargoMigrationPanel {...createProps()} />);

    expect(screen.getAllByText("探险杯套装").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SKU-001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已暂存").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥11.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("218g").length).toBeGreaterThan(0);
    expect(screen.getAllByText("名称继承自第 2 行").length).toBeGreaterThan(0);
    expect(screen.queryByText("file-token-SKU-001")).not.toBeInTheDocument();
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();

    const phraseInput = screen.getByLabelText("确认语句");
    const confirmButton = screen.getByRole("button", {
      name: "确认迁移 74 个 SKU",
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
      await screen.findByRole("alertdialog", { name: "确认导入 74 个 SKU" }),
    ).toBeVisible();
  });

  it("keeps confirmation disabled for blocking runs and removes first-import controls after import", () => {
    const { rerender } = render(
      <CargoMigrationPanel
        {...createProps({
          latestMigrationRun: {
            ...createProps().latestMigrationRun!,
            blockingIssueCount: 2,
            issueCount: 2,
            rows: [
              {
                ...createProps().latestMigrationRun!.rows[0],
                issueLabels: ["SKU 缺少必填规格"],
              },
            ],
            status: "PREFLIGHT_BLOCKED",
            statusLabel: "预检阻断",
            statusTone: "danger",
          },
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "确认迁移 74 个 SKU" }),
    ).toBeDisabled();
    expect(screen.getAllByText("SKU 缺少必填规格").length).toBeGreaterThan(0);

    rerender(
      <CargoMigrationPanel
        {...createProps({
          latestMigrationRun: {
            ...createProps().latestMigrationRun!,
            blockingIssueCount: 0,
            imageStateLabel: "已导入",
            importedAtLabel: "2026/08/13 14:45",
            issueCount: 0,
            rows: [
              {
                ...createProps().latestMigrationRun!.rows[0],
                imageStateLabel: "已导入",
                issueLabels: [],
              },
            ],
            status: "IMPORTED",
            statusLabel: "已导入",
            statusTone: "success",
            warningIssueCount: 0,
          },
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "开始只读预检" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认迁移 74 个 SKU" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("已导入").length).toBeGreaterThan(0);
  });
});
