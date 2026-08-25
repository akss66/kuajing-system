// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/orders",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { OrderFilterBar } from "@/components/orders/order-filter-bar";

afterEach(() => cleanup());

describe("OrderFilterBar", () => {
  it("uses the shared select surface for customer order status", () => {
    const { container } = render(
      <OrderFilterBar
        audience="customer"
        statusOptions={[
          { label: "待付款", value: "PENDING_PAYMENT" },
          { label: "已发货", value: "SHIPPED" },
        ]}
        values={{ status: "PENDING_PAYMENT" }}
      />,
    );

    const status = screen.getByRole("combobox", { name: "状态" });
    expect(status).toHaveAttribute("data-slot", "select-trigger");
    expect(status).toHaveTextContent("待付款");
    expect(container.querySelector("select:not([aria-hidden='true'])")).not.toBeInTheDocument();
  });
});
