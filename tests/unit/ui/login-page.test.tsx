// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

import LoginPage from "@/app/(auth)/login/page";

describe("login page", () => {
  it("presents the approved merchant login copy and brand lockup", () => {
    render(<LoginPage />);

    expect(screen.getByText("加拿大本地货盘，")).toBeVisible();
    expect(screen.getByText("一站式经营更简单。")).toBeVisible();
    expect(
      screen.getByText("一键上传订单、跟进付款与发货状态，让每一次发货都清晰、可追踪、可恢复。"),
    ).toBeVisible();
    expect(screen.getByText("AI+Agent+跨境")).toBeVisible();
    expect(screen.queryByText("WELCOME BACK")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "登录同舟行跨境" })).not.toBeInTheDocument();
    expect(screen.getByText("使用管理员为你开通的账号进入系统。")).toBeVisible();
    expect(screen.getByLabelText("登录邮箱")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("登录邮箱")).not.toHaveAttribute("placeholder");
    expect(screen.getByLabelText("登录密码")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("登录密码")).not.toHaveAttribute("placeholder");
    expect(screen.getByRole("button", { name: "登录系统" })).toBeEnabled();
    const signature = screen.getByText("Designed & Developed by ZZY");
    const loginPanel = document.querySelector("[data-login-panel]");
    const loginScene = document.querySelector("[data-threeui-scene='login']");
    expect(signature).toBeVisible();
    expect(loginPanel).not.toContainElement(signature);
    expect(loginScene).toHaveAttribute("data-threeui-state", "fallback");
    expect(loginScene).toHaveAttribute("aria-hidden", "true");
    expect(loginPanel).toHaveClass("w-full", "max-w-[27rem]");
    expect(loginPanel).not.toHaveClass(
      "rounded-[1.75rem]",
      "border",
      "shadow-[0_28px_90px_rgb(15_55_47/0.12)]",
      "backdrop-blur-xl",
    );
    expect(screen.getByRole("img", { name: "同舟行跨境" })).toHaveAttribute(
      "src",
      expect.stringContaining("tongzhouxing-logo.png"),
    );
    expect(screen.queryByText(/履约/)).not.toBeInTheDocument();
  });

  it("keeps product typography on the global token instead of page-level overrides", () => {
    const root = process.cwd();
    const layoutSource = readFileSync(join(root, "src/app/layout.tsx"), "utf8");
    const globalsSource = readFileSync(join(root, "src/app/globals.css"), "utf8");
    const fontOverrides = collectFontOverrides(join(root, "src"));

    expect(layoutSource).toContain("@fontsource-variable/geist");
    expect(layoutSource).toContain("@fontsource-variable/noto-sans-sc");
    expect(globalsSource).toContain("--font-product");
    expect(globalsSource).toContain("var(--font-product)");
    expect(fontOverrides).toEqual([]);
  });
});

function collectFontOverrides(directory: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      results.push(...collectFontOverrides(fullPath));
      continue;
    }

    if (!/\.(css|tsx|ts|jsx|js)$/.test(entry) || fullPath.endsWith("globals.css")) {
      continue;
    }

    const source = readFileSync(fullPath, "utf8");
    if (source.includes("font-family") || source.includes("font-[")) {
      results.push(fullPath);
    }
  }

  return results;
}
