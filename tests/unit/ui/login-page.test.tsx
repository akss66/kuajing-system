// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LoginPage from "@/app/(auth)/login/page";

describe("login page", () => {
  it("presents an accessible sign-in form under the approved brand", () => {
    render(<LoginPage />);

    expect(screen.getByRole("heading", { name: "登录同舟行跨境" })).toBeVisible();
    expect(screen.getByLabelText("登录邮箱")).toHaveAttribute("type", "email");
    expect(screen.getByLabelText("登录密码")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "登录系统" })).toBeEnabled();
    expect(screen.getByRole("img", { name: "同舟行跨境" })).toHaveAttribute(
      "src",
      expect.stringContaining("tongzhouxing-logo.png"),
    );
  });
});
