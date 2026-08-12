// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/settlement/actions", () => ({
  reviewSettlementPaymentAction: vi.fn(),
}));

import { AdminSettlementReview } from "@/components/settlement/admin-settlement-review";

describe("AdminSettlementReview", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a unified settlement review summary without exposing raw enums", () => {
    render(
      <AdminSettlementReview
        auditEntries={[
          {
            actionLabel: "客户提交付款声明",
            actorLabel: "客户",
            createdAtLabel: "2026/08/12 17:10",
            id: "audit-1",
            reason: "客户声明整批微信付款已完成",
          },
        ]}
        batch={{
          batchNumber: "SET-20260812-01",
          claimStatusLabel: "待审核",
          customerLabel: "BULK-TEST · 多店铺客户",
          id: "batch-1",
          offlineAmountFen: 2200,
          paidAtLabel: "—",
          paymentReportedAtLabel: "2026/08/12 17:10",
          statusLabel: "等待统一核款",
          totalAmountFen: 10800,
          walletAmountFen: 8600,
          walletHoldLabel: "冻结中",
        }}
        claim={{
          amountFen: 2200,
          createdAtLabel: "2026/08/12 17:10",
          note: "微信已付款，等待管理员统一核款",
          statusLabel: "待审核",
        }}
        orders={Array.from({ length: 8 }, (_, index) => ({
          offlineAmountFen: index === 0 ? 300 : 271,
          orderId: `order-${index + 1}`,
          orderNumber: `FH-20260812-0${index + 1}`,
          statusLabel: "待付款",
          storeName: `TEMU 店铺 ${index + 1}`,
          totalAmountFen: 1350,
          walletAmountFen: index === 0 ? 1050 : 1079,
        }))}
      />,
    );

    expect(screen.getByRole("heading", { name: "统一核款：8 张拿货单" })).toBeVisible();
    expect(screen.getByText("余额冻结 ¥86.00")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认已收款" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拒绝付款声明" })).toBeEnabled();
    expect(screen.getByText("客户提交付款声明")).toBeVisible();
    expect(screen.queryByText("PAYMENT_REPORTED")).not.toBeInTheDocument();
    expect(screen.queryByText("PENDING_PAYMENT")).not.toBeInTheDocument();
  });
});
