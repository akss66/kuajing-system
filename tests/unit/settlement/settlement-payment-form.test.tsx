// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionState } from "@/shared/action-state";

const actionStateMocks = vi.hoisted(() => ({
  state: { status: "idle" } as ActionState,
  action: vi.fn(),
  pending: false,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: () => [
      actionStateMocks.state,
      actionStateMocks.action,
      actionStateMocks.pending,
    ],
  };
});

vi.mock("@/modules/settlement/actions", () => ({
  reportSettlementPaymentAction: vi.fn(),
  withdrawSettlementPaymentAction: vi.fn(),
}));

import { SettlementPaymentForm } from "@/components/settlement/settlement-payment-form";

describe("SettlementPaymentForm", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    actionStateMocks.state = { status: "idle" };
    actionStateMocks.pending = false;
  });

  it("focuses the first actionable payment control when the action returns an error", async () => {
    actionStateMocks.state = {
      status: "error",
      message: "请先填写付款备注后再提交。",
    };

    render(
      <SettlementPaymentForm
        claimStatus={null}
        offlineAmountFen={168800}
        settlementBatchId="batch-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("请先填写付款备注后再提交。");
      expect(screen.getByLabelText("付款备注（选填）")).toHaveFocus();
    });
  });

  it("focuses the withdrawal reason when a pending payment declaration returns an error", async () => {
    actionStateMocks.state = {
      status: "error",
      message: "请说明撤回原因后再提交。",
    };

    render(
      <SettlementPaymentForm
        claimStatus="PENDING"
        offlineAmountFen={168800}
        settlementBatchId="batch-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("请说明撤回原因后再提交。");
      expect(screen.getByLabelText("撤回原因")).toHaveFocus();
    });
  });

  it.each([
    ["no claim", null],
    ["a pending claim", "PENDING"],
  ] as const)("renders a focusable payment declaration target for %s", (_description, claimStatus) => {
    const { container } = render(
      <SettlementPaymentForm
        claimStatus={claimStatus}
        offlineAmountFen={168800}
        settlementBatchId="batch-1"
      />,
    );

    const target = container.querySelector<HTMLElement>("#settlement-payment-form");
    expect(target).toHaveAttribute("tabindex", "-1");
    target?.focus();
    expect(target).toHaveFocus();
  });

  it("does not offer report or withdrawal actions after the settlement is closed", () => {
    render(
      <SettlementPaymentForm
        claimStatus="REJECTED"
        offlineAmountFen={168800}
        reportingOpen={false}
        settlementBatchId="batch-1"
        withdrawalOpen={false}
      />,
    );

    expect(screen.getByText("本次合并付款已结束，不能再提交或撤回付款声明。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已微信付款" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤回整笔声明" })).not.toBeInTheDocument();
  });

  it("offers withdrawal without reopening payment reporting while a declaration awaits review", () => {
    render(
      <SettlementPaymentForm
        claimStatus="PENDING"
        offlineAmountFen={168800}
        reportingOpen={false}
        settlementBatchId="batch-1"
        withdrawalOpen
      />,
    );

    expect(screen.getByRole("button", { name: "撤回整笔声明" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已微信付款" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("本次合并付款已结束，不能再提交或撤回付款声明。"),
    ).not.toBeInTheDocument();
  });
});
