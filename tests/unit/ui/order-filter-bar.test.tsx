// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationMocks = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/orders",
  useRouter: () => ({ replace: navigationMocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

import { OrderFilterBar } from "@/components/orders/order-filter-bar";

afterEach(() => cleanup());

describe("OrderFilterBar", () => {
  beforeEach(() => {
    navigationMocks.replace.mockReset();
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

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

  it("serializes the selected status into the customer order query", () => {
    render(
      <OrderFilterBar
        audience="customer"
        statusOptions={[
          { label: "待付款", value: "PENDING_PAYMENT" },
          { label: "已发货", value: "SHIPPED" },
        ]}
        values={{}}
      />,
    );

    const status = screen.getByRole("combobox", { name: "状态" });
    fireEvent.pointerDown(status, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: "已发货" }));
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));

    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/portal/orders?status=SHIPPED",
      { scroll: false },
    );
  });
});
