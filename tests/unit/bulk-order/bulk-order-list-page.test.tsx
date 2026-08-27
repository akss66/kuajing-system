// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const draftMocks = vi.hoisted(() => ({ listBulkDrafts: vi.fn() }));
const storeMocks = vi.hoisted(() => ({ listActiveCustomerStores: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/modules/identity/guards", () => identityMocks);
vi.mock("@/modules/bulk-order/draft-service", () => draftMocks);
vi.mock("@/modules/order-import/service", () => storeMocks);
vi.mock("@/modules/bulk-order/actions", () => ({
  createBulkDraftAction: vi.fn(),
  discardBulkDraftAction: vi.fn(),
}));

import CustomerBulkOrdersPage from "@/app/(customer)/portal/bulk-orders/page";

describe("CustomerBulkOrdersPage", () => {
  beforeEach(() => {
    identityMocks.requireCustomer.mockResolvedValue({ customerId: "customer-1" });
    storeMocks.listActiveCustomerStores.mockResolvedValue([
      { id: "store-1", name: "TEMU 一店", platform: "TEMU" },
    ]);
    draftMocks.listBulkDrafts.mockResolvedValue([
      {
        createdAt: new Date("2026-08-13T04:00:00.000Z"),
        expiresAt: new Date("2099-08-14T04:00:00.000Z"),
        fileCount: 0,
        groupCount: 0,
        id: "draft-empty",
        status: "DRAFT",
        submittableGroupCount: 0,
        updatedAt: new Date("2026-08-13T04:00:00.000Z"),
      },
      {
        createdAt: new Date("2026-08-13T01:00:00.000Z"),
        expiresAt: new Date("2099-08-14T01:00:00.000Z"),
        fileCount: 3,
        groupCount: 2,
        id: "draft-latest",
        status: "PARTIALLY_SUBMITTED",
        submittableGroupCount: 1,
        updatedAt: new Date("2026-08-13T03:00:00.000Z"),
      },
      {
        createdAt: new Date("2026-08-12T01:00:00.000Z"),
        expiresAt: new Date("2026-08-13T01:00:00.000Z"),
        fileCount: 1,
        groupCount: 1,
        id: "draft-expired",
        status: "EXPIRED",
        submittableGroupCount: 0,
        updatedAt: new Date("2026-08-12T03:00:00.000Z"),
      },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("prioritizes one active upload without exposing a duplicate start action", async () => {
    const { container } = render(await CustomerBulkOrdersPage());

    const actions = screen.getByRole("region", { name: "多店铺上传下一步" });
    const continuation = within(actions).getByRole("link", { name: "继续上次上传" });

    expect(continuation).toHaveAttribute("href", "/portal/bulk-orders/draft-empty");
    expect(within(actions).queryByRole("button", { name: "开始批量上传" })).not.toBeInTheDocument();
    expect(actions).toHaveTextContent("0 个店铺");
    expect(actions).toHaveTextContent("0 个文件");
    expect(screen.getByRole("link", { name: "查看合并付款记录" })).toHaveAttribute(
      "href",
      "/portal/settlements",
    );
    expect(screen.getByText("可提交店铺").closest("[data-metric-card]")).toHaveTextContent("1");
    expect(container.querySelector("[data-metric-strip]")).not.toBeNull();
    expect(screen.getByText("进行中上传")).toBeVisible();
    expect(screen.getByText("已上传文件")).toBeVisible();
    expect(screen.getByRole("region", { name: "上传记录" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "上传记录" })).toBeVisible();
    expect(screen.getByRole("button", { name: "放弃空白上传" })).toBeVisible();
    expect(screen.queryByText("新建批量草稿")).not.toBeInTheDocument();
  });

  it("presents time-expired editable drafts as expired and view-only", async () => {
    draftMocks.listBulkDrafts.mockResolvedValue(
      ["DRAFT", "PARTIALLY_SUBMITTED"].map((status, index) => ({
        createdAt: new Date(`2026-08-0${index + 1}T01:00:00.000Z`),
        expiresAt: new Date("2026-08-10T01:00:00.000Z"),
        fileCount: index + 1,
        groupCount: index + 1,
        id: `time-expired-${status.toLowerCase()}`,
        status,
        submittableGroupCount: index,
        updatedAt: new Date(`2026-08-0${index + 1}T03:00:00.000Z`),
      })),
    );

    render(await CustomerBulkOrdersPage());

    expect(screen.getAllByText("已过期")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "查看记录" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "继续上传" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "继续上次上传" })).not.toBeInTheDocument();
    expect(screen.getByText("可提交店铺").closest("[data-metric-card]")).toHaveTextContent("0");
  });

  it("keeps the first-use state focused on starting an upload", async () => {
    draftMocks.listBulkDrafts.mockResolvedValue([]);

    render(await CustomerBulkOrdersPage());

    expect(screen.getByRole("region", { name: "多店铺上传下一步" })).toBeVisible();
    expect(screen.getByRole("button", { name: "开始批量上传" })).toBeEnabled();
    expect(screen.getByText("当前上传概况")).toBeVisible();
    expect(screen.getByRole("region", { name: "上传记录" })).toBeVisible();
    expect(screen.getByText("还没有上传记录")).toBeVisible();
    expect(screen.getByRole("link", { name: "先查看合并付款记录" })).toHaveAttribute(
      "href",
      "/portal/settlements",
    );
  });
});
