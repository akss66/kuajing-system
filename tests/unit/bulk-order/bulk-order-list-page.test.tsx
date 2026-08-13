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
vi.mock("@/modules/bulk-order/actions", () => ({ createBulkDraftAction: vi.fn() }));

import CustomerBulkOrdersPage from "@/app/(customer)/portal/bulk-orders/page";

describe("CustomerBulkOrdersPage", () => {
  beforeEach(() => {
    identityMocks.requireCustomer.mockResolvedValue({ customerId: "customer-1" });
    storeMocks.listActiveCustomerStores.mockResolvedValue([
      { id: "store-1", name: "TEMU 一店", platform: "TEMU" },
    ]);
    draftMocks.listBulkDrafts.mockResolvedValue([
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

  it("prioritizes continuing the latest writable draft beside starting a new batch", async () => {
    render(await CustomerBulkOrdersPage());

    const actions = screen.getByRole("region", { name: "批量拿货下一步" });
    const continuation = within(actions).getByRole("link", { name: "继续上次草稿" });

    expect(continuation).toHaveAttribute("href", "/portal/bulk-orders/draft-latest");
    expect(within(actions).getByRole("button", { name: "新建批量草稿" })).toBeEnabled();
    expect(actions).toHaveTextContent("2 个店铺");
    expect(actions).toHaveTextContent("3 个文件");
    expect(screen.getByText("可继续提交").closest("article")).toHaveTextContent("1");
  });
});
