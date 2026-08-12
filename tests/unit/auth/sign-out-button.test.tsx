// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

const authClientMocks = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("@/modules/identity/auth-client", () => ({
  authClient: authClientMocks,
}));

import { SignOutButton } from "@/components/auth/sign-out-button";

describe("SignOutButton", () => {
  beforeEach(() => {
    authClientMocks.signOut.mockReset();
    routerMocks.refresh.mockReset();
    routerMocks.replace.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("signs out the current session and returns the operator to /login", async () => {
    let resolveSignOut: ((value: { error: null }) => void) | undefined;
    authClientMocks.signOut.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignOut = resolve;
        }),
    );

    render(<SignOutButton />);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(authClientMocks.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在退出登录" })).toBeDisabled();

    if (!resolveSignOut) {
      throw new Error("Expected signOut promise resolver to be assigned.");
    }

    resolveSignOut({ error: null });

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith("/login");
      expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("shows a recoverable error when sign-out fails and does not navigate away", async () => {
    authClientMocks.signOut.mockResolvedValue({
      error: {
        message: "network",
      },
    });

    render(<SignOutButton />);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("退出登录失败，请稍后再试。");
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
  });

  it("recovers from a rejected sign-out request and allows retrying", async () => {
    authClientMocks.signOut.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce({
      error: null,
    });

    render(<SignOutButton />);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("退出登录失败，请稍后再试。");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => {
      expect(authClientMocks.signOut).toHaveBeenCalledTimes(2);
      expect(routerMocks.replace).toHaveBeenCalledWith("/login");
      expect(routerMocks.refresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
