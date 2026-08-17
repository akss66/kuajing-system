// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, waitFor } from "@testing-library/react";
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
