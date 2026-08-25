// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
}));

vi.mock("@/modules/identity/auth-client", () => ({
  authClient: { signIn: { email: mocks.signIn } },
}));

import { LoginForm } from "@/components/auth/login-form";

describe("LoginForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("does not expose credentials to a native GET before hydration", () => {
    const preHydrationDocument = document.implementation.createHTMLDocument();
    preHydrationDocument.body.innerHTML = renderToStaticMarkup(<LoginForm />);
    const form = preHydrationDocument.querySelector<HTMLFormElement>("form");
    const email = preHydrationDocument.querySelector<HTMLInputElement>('input[name="email"]');
    const password = preHydrationDocument.querySelector<HTMLInputElement>(
      'input[name="password"]',
    );
    const submit = preHydrationDocument.querySelector<HTMLButtonElement>('button[type="submit"]');

    expect(form).not.toBeNull();
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
    expect(submit).not.toBeNull();

    email!.value = "customer@example.com";
    password!.value = "never-appear-in-a-url";
    const method = form!.method.toLowerCase();
    const nativeTarget = new URL(form!.action || "/login", "https://shop.tzxai.top/login");
    if (method === "get") {
      nativeTarget.search = new URLSearchParams(
        Array.from(new FormData(form!).entries(), ([key, value]) => [key, String(value)]),
      ).toString();
    }

    expect(method).toBe("post");
    expect(email!.hasAttribute("disabled")).toBe(true);
    expect(password!.hasAttribute("disabled")).toBe(true);
    expect(submit!.hasAttribute("disabled")).toBe(true);
    expect(nativeTarget.href).not.toContain("customer%40example.com");
    expect(nativeTarget.href).not.toContain("never-appear-in-a-url");
  });

  it("routes a super administrator to the admin workspace after login", async () => {
    mocks.signIn.mockResolvedValue({
      data: { user: { role: "super_admin" } },
      error: null,
    });
    const { container } = render(<LoginForm />);
    const email = container.querySelector<HTMLInputElement>('input[name="email"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    const form = container.querySelector<HTMLFormElement>("form");

    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
    expect(form).not.toBeNull();
    expect(email?.getAttribute("placeholder")).toBeNull();
    expect(password?.getAttribute("placeholder")).toBeNull();
    fireEvent.change(email!, { target: { value: "admin@example.com" } });
    fireEvent.change(password!, { target: { value: "a-valid-password" } });
    fireEvent.submit(form!);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/admin"));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
