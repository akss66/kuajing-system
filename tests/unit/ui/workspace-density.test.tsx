// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";

describe("workspace density primitives", () => {
  afterEach(() => cleanup());

  it("keeps five metrics on one desktop row without leaving an orphan mobile card", () => {
    render(
      <MetricStrip
        items={Array.from({ length: 5 }, (_, index) => ({
          label: `指标 ${index + 1}`,
          value: String(index + 1),
        }))}
      />,
    );

    const strip = document.querySelector<HTMLElement>("[data-metric-strip]");
    const cards = document.querySelectorAll<HTMLElement>("[data-metric-card]");
    expect(strip).toHaveAttribute("data-metric-count", "5");
    expect(strip).toHaveClass("xl:grid-cols-5");
    expect(cards[4]).toHaveClass("col-span-2", "sm:col-span-1");
  });

  it("uses a compact mobile heading and lets its action occupy the available width", () => {
    render(<PageHeading action={<button type="button">主要操作</button>} title="订单管理" />);

    expect(screen.getByRole("heading", { name: "订单管理" })).toHaveClass("text-[1.55rem]");
    expect(document.querySelector("[data-page-heading-action]")).toHaveClass("w-full", "sm:w-auto");
  });
});
