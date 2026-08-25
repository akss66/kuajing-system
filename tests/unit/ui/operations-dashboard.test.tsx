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
          pendingOfflineRefundAmountFen: 2_600,
          pendingOfflineRefundCount: 2,
          pendingPaymentReviewCount: 5,
          sevenDaySeries: [
            { date: "2026-08-07", netOrderAmountFen: 0, orderCount: 0 },
            { date: "2026-08-08", netOrderAmountFen: 0, orderCount: 0 },
            { date: "2026-08-09", netOrderAmountFen: 0, orderCount: 0 },
            { date: "2026-08-10", netOrderAmountFen: 0, orderCount: 0 },
            { date: "2026-08-11", netOrderAmountFen: 0, orderCount: 0 },
            { date: "2026-08-12", netOrderAmountFen: 0, orderCount: 0 },
            { date: "2026-08-13", netOrderAmountFen: 0, orderCount: 0 },
          ],
          todayNetOrderAmountFen: 12_345,
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
    expect(screen.getByText("下单净额")).toBeVisible();
    expect(screen.getByText("拿货单与下单净额")).toBeVisible();
    expect(screen.getByRole("link", { name: /待线下退款.*¥26\.00.*2/ })).toHaveAttribute(
      "href",
      "/admin/settlement#pending-offline-refunds",
    );
    expect(document.body).not.toHaveTextContent("成交金额");
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
            label: "查看批量付款 SETTLEMENT-1 的核款进度",
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
    expect(document.querySelector("[data-portal-continuation]")).toBeInTheDocument();
    expect(document.querySelector("[data-portal-task-overview]")).toBeInTheDocument();
    expect(document.querySelector("[data-portal-quick-actions]")).toBeInTheDocument();
    expect(document.querySelector("[data-portal-summary-grid]")).toBeInTheDocument();
    expect(
      continuation.compareDocumentPosition(storeSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /查看付款确认进度/ }),
    ).toHaveAttribute("href", "/portal/settlements/settlement-1");
    expect(screen.getByRole("link", { name: /实时货盘/ })).toHaveAttribute(
      "href",
      "/portal/catalog",
    );
    expect(screen.getByRole("link", { name: /资金中心/ })).toHaveAttribute(
      "href",
      "/portal/wallet",
    );
    expect(screen.getByRole("link", { name: /需要协助/ })).toHaveAttribute(
      "href",
      "/portal/orders?status=FULFILLMENT_EXCEPTION",
    );
    expect(screen.queryByRole("link", { name: /付款待确认/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /未完成上传/ })).not.toBeInTheDocument();
    expect(screen.getByText("北美主店")).toBeVisible();
    expect(document.body).not.toHaveTextContent("批量付款");
    expect(document.body).not.toHaveTextContent("仓库处理异常");
    expect(document.body).not.toHaveTextContent("390 px");
    expect(document.body).not.toHaveTextContent("2 种");
    expect(document.body).not.toHaveTextContent("快捷入口");
  });

  it("renders a calm ready state when the customer has no unfinished work", () => {
    render(
      <CustomerTaskDashboard
        dashboard={{
          activeStoreCount: 1,
          fulfillmentExceptionCount: 0,
          pendingPaymentCount: 0,
          pendingPaymentFen: 0,
          paymentReportedCount: 0,
          primaryContinuationTarget: null,
          recentStoreSummaries: [],
          unfinishedDraftCount: 0,
          walletAvailableFen: 0,
          walletBalanceFen: 0,
          walletHoldFen: 0,
        }}
      />,
    );

    const readyState = screen.getByRole("status", { name: "当前拿货均已处理完成" });
    expect(readyState).toHaveAttribute("data-portal-ready");
    expect(document.querySelector("[data-portal-task-overview]")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /上传订单/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /上传订单/ })).toHaveAttribute(
      "href",
      "/portal/imports/new",
    );
  });
});
