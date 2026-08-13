// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import type { ManagedAction } from "@/shared/action-state";

const successfulAction: ManagedAction = async () => ({ status: "success" });

afterEach(() => {
  cleanup();
});

describe("inventory workspace", () => {
  it("leads with stock risk and keeps audited inventory editing in a drawer", async () => {
    render(
      <InventoryWorkspace
        adjustInventoryAction={successfulAction}
        recentMovements={[
          {
            afterQuantity: 13,
            createdAt: "2026-08-13T12:00:00.000Z",
            delta: 8,
            id: "movement-1",
            movementType: "MANUAL_INCREASE",
            reason: "首批入库",
            skuCode: "TZX-LOW-001",
          },
        ]}
        rows={[
          {
            alertLevel: "CRITICAL",
            available: 2,
            coverageDays: 6,
            id: "sku-low",
            locked: 3,
            name: "低库存规格",
            shippedQuantity7d: 4,
            skuCode: "TZX-LOW-001",
            total: 5,
          },
          {
            alertLevel: "NONE",
            available: 20,
            coverageDays: 60,
            id: "sku-ok",
            locked: 0,
            name: "库存充足规格",
            shippedQuantity7d: 2,
            skuCode: "TZX-OK-002",
            total: 20,
          },
        ]}
      />,
    );

    expect(screen.getByRole("searchbox", { name: "搜索库存 SKU" })).toBeVisible();
    const health = screen.getByRole("region", { name: "库存健康摘要" });
    expect(health).toHaveTextContent("可售库存");
    expect(health).toHaveTextContent("22");

    const riskQueue = screen.getByRole("region", { name: "低库存队列" });
    expect(riskQueue).toHaveTextContent("TZX-LOW-001");
    expect(riskQueue).not.toHaveTextContent("TZX-OK-002");

    const table = screen.getByRole("table", { name: "实时库存列表" });
    for (const header of ["总库存", "订单锁定", "可售库存"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeVisible();
    }

    expect(screen.getByRole("region", { name: "最近库存变动" })).toHaveTextContent("首批入库");
    expect(screen.queryByLabelText("调整数量")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("调整原因")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "调整库存" }));
    const drawer = await screen.findByRole("dialog", { name: "调整库存" });
    expect(within(drawer).getByLabelText("调整数量")).toBeVisible();
    expect(within(drawer).getByLabelText("调整原因")).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "确认调整库存" })).toBeEnabled();
  });

  it("filters inventory without dropping stock facts", () => {
    render(
      <InventoryWorkspace
        adjustInventoryAction={successfulAction}
        recentMovements={[]}
        rows={[
          {
            alertLevel: "NO_BASELINE",
            available: 10,
            coverageDays: null,
            id: "sku-1",
            locked: 0,
            name: "黑色 10 件装",
            shippedQuantity7d: 0,
            skuCode: "TZX-DEMO-001",
            total: 10,
          },
          {
            alertLevel: "WARNING",
            available: 3,
            coverageDays: 35,
            id: "sku-2",
            locked: 2,
            name: "白色 20 件装",
            shippedQuantity7d: 1,
            skuCode: "TZX-WHITE-002",
            total: 5,
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索库存 SKU" }), {
      target: { value: "WHITE" },
    });

    const table = screen.getByRole("table", { name: "实时库存列表" });
    expect(within(table).queryByText("TZX-DEMO-001")).not.toBeInTheDocument();
    const row = within(table).getByRole("row", { name: /TZX-WHITE-002/ });
    expect(row).toHaveTextContent("5");
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("3");
  });

  it("orders the low-stock queue by risk before the incoming balance freshness", () => {
    const rowsFromUpdatedAtDescending = [
      {
        alertLevel: "WARNING" as const,
        available: 8,
        coverageDays: 35,
        id: "sku-warning-newer",
        locked: 2,
        name: "近期更新的预警规格",
        shippedQuantity7d: 2,
        skuCode: "TZX-WARNING-NEWER",
        total: 10,
      },
      {
        alertLevel: "CRITICAL" as const,
        available: 2,
        coverageDays: 12,
        id: "sku-critical-older",
        locked: 3,
        name: "较早更新的紧急规格",
        shippedQuantity7d: 1,
        skuCode: "TZX-CRITICAL-OLDER",
        total: 5,
      },
    ];

    render(
      <InventoryWorkspace
        adjustInventoryAction={successfulAction}
        recentMovements={[]}
        rows={rowsFromUpdatedAtDescending}
      />,
    );

    const riskItems = within(screen.getByRole("region", { name: "低库存队列" }))
      .getAllByRole("listitem");
    expect(riskItems).toHaveLength(2);
    expect(riskItems[0]).toHaveTextContent("TZX-CRITICAL-OLDER");
    expect(riskItems[1]).toHaveTextContent("TZX-WARNING-NEWER");
  });
});
