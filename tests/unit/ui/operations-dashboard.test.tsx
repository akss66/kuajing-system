// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { AdminOperationsDashboard } from "@/components/dashboard/admin-operations-dashboard";
import { CustomerTaskDashboard } from "@/components/dashboard/customer-task-dashboard";

afterEach(() => cleanup());

describe("operations dashboards", () => {
  it("renders the four admin operations layers from supplied data", () => {
    render(
      <AdminOperationsDashboard
        dashboard={{
          criticalStockCount: 2,
          fulfillmentExceptionCount: 1,
          importExceptionCount: 3,
          pendingFulfillmentCount: 4,
          pendingPaymentReviewCount: 5,
          sevenDaySeries: [
            { date: "2026-08-07", gmvFen: 0, orderCount: 0 },
            { date: "2026-08-08", gmvFen: 0, orderCount: 0 },
            { date: "2026-08-09", gmvFen: 0, orderCount: 0 },
            { date: "2026-08-10", gmvFen: 0, orderCount: 0 },
            { date: "2026-08-11", gmvFen: 0, orderCount: 0 },
            { date: "2026-08-12", gmvFen: 0, orderCount: 0 },
            { date: "2026-08-13", gmvFen: 0, orderCount: 0 },
          ],
          todayGmvFen: 12_345,
          todayOrderCount: 6,
          todayShippedCount: 7,
          topSkus: [],
          topStores: [],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "今日经营" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "待办与预警" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "近 7 天趋势" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "快捷处理" })).toBeVisible();
    expect(screen.getByText("暂无趋势数据")).toBeVisible();
    expect(screen.getByText("¥123.45")).toBeVisible();
    expect(screen.getByRole("link", { name: /审核收款/ })).toHaveAttribute(
      "href",
      "/admin/settlement-batches?status=PAYMENT_REPORTED",
    );
    expect(document.body).not.toHaveTextContent("合作客户");
    expect(document.body).not.toHaveTextContent("TEMU 店铺");
    expect(document.body).not.toHaveTextContent("在售 SKU");
  });

  it("puts customer continuation tasks before static store and money summaries", () => {
    render(
      <CustomerTaskDashboard
        dashboard={{
          activeStoreCount: 2,
          fulfillmentExceptionCount: 1,
          pendingPaymentCount: 2,
          pendingPaymentFen: 8_800,
          paymentReportedCount: 1,
          primaryContinuationTarget: {
            href: "/portal/settlements/settlement-1",
            kind: "PAYMENT_REPORTED",
            label: "查看结算批次 SETTLEMENT-1 的付款确认",
          },
          recentStoreSummaries: [
            {
              fulfillmentExceptionCount: 1,
              pendingPaymentCount: 2,
              pendingPaymentFen: 8_800,
              recentOrderCount: 6,
              storeId: "store-1",
              storeName: "北美主店",
            },
          ],
          unfinishedDraftCount: 0,
          walletAvailableFen: 9_000,
          walletBalanceFen: 10_000,
          walletHoldFen: 1_000,
        }}
      />,
    );

    const continuation = screen.getByRole("heading", { name: "继续处理" });
    const quickPurchase = screen.getByRole("heading", { name: "快捷拿货" });
    const storeSummary = screen.getByRole("heading", { name: "店铺摘要" });
    const fundsSummary = screen.getByRole("heading", { name: "资金摘要" });

    expect(continuation).toBeVisible();
    expect(quickPurchase).toBeVisible();
    expect(storeSummary).toBeVisible();
    expect(fundsSummary).toBeVisible();
    expect(
      continuation.compareDocumentPosition(storeSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /查看结算批次 SETTLEMENT-1 的付款确认/ }),
    ).toHaveAttribute("href", "/portal/settlements/settlement-1");
    expect(screen.getByText("北美主店")).toBeVisible();
    expect(document.body).not.toHaveTextContent("390 px");
    expect(document.body).not.toHaveTextContent("2 种");
    expect(document.body).not.toHaveTextContent("快捷入口");
  });
});
