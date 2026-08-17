// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/inventory/actions", () => ({
  adjustInventoryAction: vi.fn(),
  setInventoryToActualCountAction: vi.fn(),
}));
vi.mock("@/modules/inventory/read-model", () => ({
  listInventoryMovements: vi.fn(),
  listInventorySnapshot: vi.fn(),
}));
vi.mock("@/modules/reports/stock-coverage", () => ({
  getStockCoverageReport: vi.fn(),
}));

import {
  inventoryDateBoundary,
  toInventoryWorkspaceRow,
} from "@/app/(admin)/admin/inventory/page";
import { InventoryWorkspace } from "@/components/inventory/inventory-workspace";
import type { ManagedAction } from "@/shared/action-state";

const successfulAction: ManagedAction = async () => ({ status: "success" });

const rows = [
  {
    alertLevel: "CRITICAL" as const,
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
    alertLevel: "NONE" as const,
    available: 20,
    coverageDays: 60,
    id: "sku-ok",
    locked: 0,
    name: "库存充足规格",
    shippedQuantity7d: 2,
    skuCode: "TZX-OK-002",
    total: 20,
  },
];

const movementPage = {
  page: 2,
  pageSize: 20,
  rows: [
    {
      afterQuantity: 2,
      beforeQuantity: 3,
      createdAt: "2026-08-13T12:00:00.000Z",
      delta: -1,
      id: "movement-system",
      movementType: "SHIPMENT" as const,
      operator: { actorId: null, actorType: "SYSTEM" as const, label: "系统" },
      reasonCode: "SYSTEM_SHIPMENT" as const,
      reasonLabel: "系统发货扣减",
      relation: {
        href: "/admin/orders/order-1" as const,
        id: "shipment-1",
        label: "订单 · CA-10001",
        type: "ORDER_SHIPMENT" as const,
      },
      remark: null,
      skuCode: "TZX-LOW-001",
      skuId: "sku-low",
      source: "SYSTEM_ORDER_SHIPMENT" as const,
    },
    {
      afterQuantity: 3,
      beforeQuantity: 5,
      createdAt: "2026-08-12T12:00:00.000Z",
      delta: -2,
      id: "movement-manual",
      movementType: "MANUAL_DECREASE" as const,
      operator: { actorId: "admin-1", actorType: "ADMIN" as const, label: "仓库管理员" },
      reasonCode: "OFFLINE_FULFILLMENT" as const,
      reasonLabel: "线下发货/人工出库",
      relation: null,
      remark: "历史订单补录",
      skuCode: "TZX-LOW-001",
      skuId: "sku-low",
      source: "ADMIN_OFFLINE_FULFILLMENT" as const,
    },
  ],
  total: 42,
  totalPages: 3,
};

afterEach(cleanup);

describe("inventory workspace", () => {
  it("uses the product name instead of specification fields for inventory displays", () => {
    expect(
      toInventoryWorkspaceRow(
        {
          availableQuantity: 8,
          lockedQuantity: 2,
          productId: "product-1",
          productName: "狗绳",
          skuCode: "TZX-001-1",
          skuId: "sku-1",
          specification: "150*80",
          totalQuantity: 10,
        },
        undefined,
      ),
    ).toEqual(expect.objectContaining({ name: "狗绳" }));
  });

  it("interprets strict inventory filter dates in the Toronto business day", () => {
    expect(inventoryDateBoundary("2026-08-14", "start")?.toISOString()).toBe(
      "2026-08-14T04:00:00.000Z",
    );
    expect(inventoryDateBoundary("2026-08-14", "end")?.toISOString()).toBe(
      "2026-08-15T03:59:59.999Z",
    );
    expect(inventoryDateBoundary("2026-01-14", "start")?.toISOString()).toBe(
      "2026-01-14T05:00:00.000Z",
    );
    expect(inventoryDateBoundary("2026-02-31", "start")).toBeUndefined();
    expect(inventoryDateBoundary("14-08-2026", "start")).toBeUndefined();
  });

  it("exposes exactly the two canonical first-level inventory views", () => {
    render(
      <InventoryWorkspace
        activeView="snapshot"
        adjustInventoryAction={successfulAction}
        movementFilters={{}}
        movementPage={movementPage}
        rows={rows}
        setInventoryToActualCountAction={successfulAction}
      />,
    );

    const viewTabs = screen.getByRole("tablist", { name: "库存视图" });
    expect(within(viewTabs).getAllByRole("tab")).toHaveLength(2);
    expect(within(viewTabs).getByRole("tab", { name: "实时库存" })).toHaveAttribute(
      "href",
      "/admin/inventory",
    );
    expect(within(viewTabs).getByRole("tab", { name: "库存流水" })).toHaveAttribute(
      "href",
      "/admin/inventory?view=movements",
    );
    expect(within(viewTabs).queryByRole("tab", { name: /批量盘点/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "最近库存变动" })).not.toBeInTheDocument();
  });

  it("opens a row-scoped directional adjustment with shared defaults and six-fact preview", async () => {
    render(
      <InventoryWorkspace
        activeView="snapshot"
        adjustInventoryAction={successfulAction}
        movementFilters={{}}
        movementPage={movementPage}
        rows={rows}
        setInventoryToActualCountAction={successfulAction}
      />,
    );

    const table = screen.getByRole("table", { name: "实时库存列表" });
    expect(table).toHaveClass("table-fixed");
    expect(table.querySelectorAll("colgroup > col")).toHaveLength(9);
    const lowRow = within(table).getByRole("row", { name: /TZX-LOW-001/ });
    expect(within(lowRow).getByText("低库存规格").closest("td")).toHaveClass(
      "min-w-0",
      "whitespace-normal",
      "[overflow-wrap:anywhere]",
    );
    fireEvent.click(within(lowRow).getByRole("button", { name: "+ / - 调整 TZX-LOW-001" }));

    const drawer = await screen.findByRole("dialog", { name: "TZX-LOW-001 调整库存" });
    expect(within(drawer).getByRole("radio", { name: "增加" })).toBeChecked();
    expect(within(drawer).getByLabelText("调整原因")).toHaveValue("RESTOCK_RECEIPT");
    expect(within(drawer).getByRole("option", { name: "补货入库" })).toBeInTheDocument();
    expect(within(drawer).getByRole("option", { name: "客户退货入库" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("option", { name: "破损报废" })).not.toBeInTheDocument();
    expect(within(drawer).getByLabelText("调整数量")).toHaveAttribute("min", "1");
    expect(within(drawer).getByLabelText("调整数量")).toHaveAttribute("step", "1");

    fireEvent.change(within(drawer).getByLabelText("调整数量"), { target: { value: "4" } });
    const preview = within(drawer).getByRole("region", { name: "库存调整预览" });
    for (const fact of ["调整前总库存", "变化量", "调整后总库存", "订单锁定", "当前可售", "调整后可售"]) {
      expect(within(preview).getByText(fact)).toBeVisible();
    }
    expect(preview).toHaveTextContent("+4");
    expect(preview).toHaveTextContent("9");

    fireEvent.click(within(drawer).getByRole("radio", { name: "减少" }));
    expect(within(drawer).getByLabelText("调整原因")).toHaveValue("OFFLINE_FULFILLMENT");
    expect(within(drawer).getByRole("option", { name: "破损报废" })).toBeInTheDocument();
    expect(within(drawer).getByRole("option", { name: "其他出库" })).toBeInTheDocument();
    expect(within(drawer).queryByRole("option", { name: "客户退货入库" })).not.toBeInTheDocument();
    expect(within(drawer).getByText("仅用于未经过本系统订单的线下发货或历史补录；系统订单确认发货后会自动扣减，请勿重复调整。")).toBeVisible();
    fireEvent.change(within(drawer).getByLabelText("调整数量"), { target: { value: "3" } });
    expect(within(drawer).getByRole("alert")).toHaveTextContent("调整后总库存不能低于订单锁定");
    expect(within(drawer).getByRole("button", { name: "确认调整库存" })).toBeDisabled();
  });

  it("keeps set-to-actual as a secondary mode and explains no-change", async () => {
    render(
      <InventoryWorkspace
        activeView="snapshot"
        adjustInventoryAction={successfulAction}
        movementFilters={{}}
        movementPage={movementPage}
        rows={rows}
        setInventoryToActualCountAction={successfulAction}
      />,
    );

    const table = screen.getByRole("table", { name: "实时库存列表" });
    const lowRow = within(table).getByRole("row", { name: /TZX-LOW-001/ });
    fireEvent.click(within(lowRow).getByRole("button", { name: "+ / - 调整 TZX-LOW-001" }));
    const drawer = await screen.findByRole("dialog", { name: "TZX-LOW-001 调整库存" });

    fireEvent.click(within(drawer).getByRole("button", { name: "设置为实际库存" }));
    fireEvent.change(within(drawer).getByLabelText("盘点后实际总库存"), { target: { value: "5" } });
    expect(within(drawer).getByRole("status")).toHaveTextContent("无变化，不生成库存流水");
    expect(within(drawer).getByRole("button", { name: "确认盘点结果" })).toBeDisabled();
  });

  it("renders canonical movement filters, pagination, source distinction, and table/card fact parity", () => {
    render(
      <InventoryWorkspace
        activeView="movements"
        adjustInventoryAction={successfulAction}
        movementFilters={{
          actorId: "admin-1",
          from: "2026-08-01",
          movementType: "SHIPMENT",
          skuCode: "TZX-LOW-001",
          source: "SYSTEM_ORDER_SHIPMENT",
          to: "2026-08-14",
        }}
        movementPage={movementPage}
        rows={rows}
        setInventoryToActualCountAction={successfulAction}
      />,
    );

    const filters = screen.getByRole("search", { name: "筛选库存流水" });
    expect(within(filters).getByLabelText("SKU")).toHaveValue("TZX-LOW-001");
    expect(within(filters).getByLabelText("开始时间")).toHaveValue("2026-08-01");
    expect(within(filters).getByLabelText("结束时间")).toHaveValue("2026-08-14");
    expect(within(filters).getByLabelText("流水类型")).toHaveValue("SHIPMENT");
    expect(within(filters).getByLabelText("操作人")).toHaveValue("admin-1");
    expect(within(filters).getByLabelText("来源")).toHaveValue("SYSTEM_ORDER_SHIPMENT");
    expect(within(filters).getByRole("link", { name: "重置筛选" })).toHaveAttribute(
      "href",
      "/admin/inventory?view=movements",
    );

    const table = screen.getByRole("table", { name: "库存流水列表" });
    expect(table).toHaveClass("table-fixed");
    expect(table.querySelectorAll("colgroup > col")).toHaveLength(9);
    for (const header of ["前值", "变动", "后值", "原因与备注", "操作人", "来源", "时间", "关联单据"]) {
      expect(within(table).getByRole("columnheader", { name: header })).toBeVisible();
    }
    expect(within(table).getByText("系统订单自动发货")).toBeVisible();
    expect(within(table).getAllByText("线下发货/人工出库")).toHaveLength(2);
    expect(within(table).getByRole("link", { name: "订单 · CA-10001" })).toHaveAttribute(
      "href",
      "/admin/orders/order-1",
    );
    for (const content of ["系统发货扣减", "仓库管理员", "订单 · CA-10001"]) {
      expect(within(table).getByText(content).closest("td")).toHaveClass(
        "min-w-0",
        "whitespace-normal",
        "[overflow-wrap:anywhere]",
      );
    }

    const cards = screen.getByRole("list", { name: "库存流水列表" });
    expect(cards).toHaveTextContent(/前值3/);
    expect(cards).toHaveTextContent(/变动-1/);
    expect(cards).toHaveTextContent(/后值2/);
    expect(cards).toHaveTextContent("系统订单自动发货");
    expect(cards).toHaveTextContent("历史订单补录");

    expect(screen.getByRole("link", { name: "上一页" })).toHaveAttribute(
      "href",
      expect.stringContaining("view=movements"),
    );
    expect(screen.getByRole("link", { name: "上一页" }).getAttribute("href")).not.toContain("page=");
    expect(screen.getByRole("link", { name: "下一页" })).toHaveAttribute(
      "href",
      expect.stringContaining("page=3"),
    );
  });

  it("resets every uncontrolled movement filter when canonical URL props clear", () => {
    const { rerender } = render(
      <InventoryWorkspace
        activeView="movements"
        adjustInventoryAction={successfulAction}
        movementFilters={{
          actorId: "admin-1",
          from: "2026-08-01",
          movementType: "MANUAL_DECREASE",
          skuCode: "TZX-LOW-001",
          source: "ADMIN_OFFLINE_FULFILLMENT",
          to: "2026-08-14",
        }}
        movementPage={movementPage}
        rows={rows}
        setInventoryToActualCountAction={successfulAction}
      />,
    );

    rerender(
      <InventoryWorkspace
        activeView="movements"
        adjustInventoryAction={successfulAction}
        movementFilters={{}}
        movementPage={movementPage}
        rows={rows}
        setInventoryToActualCountAction={successfulAction}
      />,
    );

    const filters = screen.getByRole("search", { name: "筛选库存流水" });
    expect(within(filters).getByLabelText("SKU")).toHaveValue("");
    expect(within(filters).getByLabelText("开始时间")).toHaveValue("");
    expect(within(filters).getByLabelText("结束时间")).toHaveValue("");
    expect(within(filters).getByLabelText("流水类型")).toHaveValue("");
    expect(within(filters).getByLabelText("操作人")).toHaveValue("");
    expect(within(filters).getByLabelText("来源")).toHaveValue("");
  });
});
