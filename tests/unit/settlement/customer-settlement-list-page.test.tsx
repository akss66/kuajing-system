// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ requireCustomer: vi.fn() }));
const queryMocks = vi.hoisted(() => ({ listCustomerSettlementBatches: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/settlement/queries", () => queryMocks);

import CustomerSettlementListPage from "@/app/(customer)/portal/settlements/page";

describe("CustomerSettlementListPage", () => {
  afterEach(() => cleanup());

  it("connects multi-store submissions to a durable batch-payment history", async () => {
    authMocks.requireCustomer.mockResolvedValue({ customerId: "customer-1", userId: "user-1" });
    queryMocks.listCustomerSettlementBatches.mockResolvedValue([
      {
        batchNumber: "BATCH-20260824-001",
        createdAt: new Date("2026-08-24T02:00:00.000Z"),
        id: "settlement-1",
        offlineAmountFen: 1300,
        paymentDueAt: new Date("2026-08-24T04:00:00.000Z"),
        status: "PENDING_PAYMENT",
        totalAmountFen: 2100,
        walletAmountFen: 800,
      },
    ]);

    render(await CustomerSettlementListPage());

    expect(screen.getByRole("heading", { level: 1, name: "批量付款" })).toBeVisible();
    expect(screen.getByText("多店铺批量拿货提交后，每次合并付款都会保留在这里。")).toBeVisible();
    expect(screen.getByText("微信待付")).toBeVisible();
    expect(screen.getAllByText("¥13.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /继续付款/ })).toHaveAttribute(
      "href",
      "/portal/settlements/settlement-1",
    );
  });
});
