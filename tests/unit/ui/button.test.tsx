// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, buttonVariants } from "@/components/ui/button";

describe("Button", () => {
  it("uses the primary action contract with a 40px default height", () => {
    render(<Button>新建客户</Button>);
    const button = screen.getByRole("button", { name: "新建客户" });
    expect(button).toHaveClass("h-10", "bg-primary", "hover:bg-primary-hover");
    expect(button).toHaveAttribute("data-size", "default");
    expect(button).toHaveAttribute("data-variant", "default");
    expect(button.className).toMatch(/shadow-\[/);
  });

  it("keeps secondary and destructive page actions quiet", () => {
    expect(buttonVariants({ variant: "outline" })).toContain("border-border");
    expect(buttonVariants({ variant: "destructive" })).toContain("border-destructive/25");
    expect(buttonVariants({ variant: "destructive" })).toContain("bg-background");
    expect(buttonVariants({ variant: "destructiveSolid" })).toContain("bg-destructive");
  });

  it("does not submit again while disabled", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>正在保存</Button>);
    fireEvent.click(screen.getByRole("button", { name: "正在保存" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
