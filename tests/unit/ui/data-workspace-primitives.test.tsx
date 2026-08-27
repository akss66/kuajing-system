// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";

afterEach(() => {
  cleanup();
});

describe("data workspace primitives", () => {
  it("renders compact metric strips with explicit desktop column counts", () => {
    render(
      <MetricStrip
        columns={5}
        compact
        items={[
          { label: "包裹数", value: "8" },
          { label: "商品件数", value: "9" },
          { hint: "原始金额 ¥145.00", label: "当前净额", value: "¥145.00" },
          { label: "取消调整", tone: "warning", value: "-¥0.00" },
          { label: "创建时间", value: "2026/8/24 02:57" },
        ]}
      />,
    );

    const strip = document.querySelector("[data-metric-strip]");
    expect(strip).toHaveClass("xl:grid-cols-5");
    expect(screen.getByText("当前净额")).toBeVisible();
    expect(screen.getByText("原始金额 ¥145.00")).toBeVisible();
    expect(screen.getByText("-¥0.00")).toHaveClass("text-warning");
  });

  it("can render customer metrics as one segmented operating summary", () => {
    render(
      <MetricStrip
        items={[
          { label: "订单数", value: "2" },
          { label: "包裹数", value: "4" },
          { label: "商品件数", value: "6" },
          { label: "订单总额", value: "¥88.00" },
        ]}
        variant="segmented"
      />,
    );

    const strip = document.querySelector("[data-metric-strip]");
    expect(strip).toHaveAttribute("data-metric-variant", "segmented");
    expect(strip).toHaveClass("gap-0", "overflow-hidden", "border");
    expect(document.querySelectorAll("[data-metric-card]")[0]).toHaveClass(
      "rounded-none",
      "border-0",
    );
  });

  it("keeps compact workspace headers and responsive tables inside named panels", () => {
    render(
      <WorkspacePanel aria-label="订单工作区">
        <WorkspacePanelHeader
          compact
          description="先看概要，再展开明细和操作。"
          title="订单工作台"
        />
        <ResponsiveDataTable className="max-h-80">
          <table aria-label="订单列表">
            <tbody>
              <tr>
                <td>TH-20260824-1</td>
              </tr>
            </tbody>
          </table>
        </ResponsiveDataTable>
      </WorkspacePanel>,
    );

    expect(screen.getByRole("region", { name: "订单工作区" })).toBeVisible();
    expect(screen.getByText("订单工作台")).toBeVisible();
    expect(screen.getByText("先看概要，再展开明细和操作。")).toBeVisible();
    const tableWrap = document.querySelector("[data-workspace-table]");
    expect(tableWrap).toHaveClass("overflow-x-auto", "max-h-80");
    expect(screen.getByRole("table", { name: "订单列表" })).toBeVisible();
  });
});
