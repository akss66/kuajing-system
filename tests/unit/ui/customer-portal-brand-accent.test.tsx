// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerPortalBrandAccent } from "@/components/dashboard/customer-portal-brand-accent";

describe("customer portal brand accent", () => {
  it("keeps the decorative threeui trial separate from the actionable dashboard copy", () => {
    render(<CustomerPortalBrandAccent />);

    const accent = screen.getByText("CLIENT FLOW").closest("[data-portal-brand-accent]");
    expect(accent).not.toBeNull();
    expect(accent).toBeInTheDocument();
    expect(within(accent as HTMLElement).getByText("货盘、上传、订单与资金回到同一条工作线。")).toBeVisible();
    expect(
      within(accent as HTMLElement).getByText("先确认可售库存，再继续上传与跟进付款发货。"),
    ).toBeVisible();
    expect(
      (accent as HTMLElement).querySelectorAll("[data-threeui-scene='portal']"),
    ).toHaveLength(2);
    for (const decorativeScene of (accent as HTMLElement).querySelectorAll(
      "[data-threeui-scene='portal']",
    )) {
      expect(decorativeScene).toHaveAttribute("aria-hidden", "true");
      expect(decorativeScene).toHaveAttribute("data-threeui-state", "fallback");
    }
  });
});
