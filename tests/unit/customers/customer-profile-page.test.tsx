// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireCustomer: vi.fn(),
}));

const queryMocks = vi.hoisted(() => ({
  getCustomerSelfProfile: vi.fn(),
}));

const walletMocks = vi.hoisted(() => ({
  getWalletPosition: vi.fn(),
}));

vi.mock("@/modules/identity/guards", () => authMocks);
vi.mock("@/modules/customers/queries", () => queryMocks);
vi.mock("@/modules/wallet/queries", () => walletMocks);

import CustomerProfilePage from "@/app/(customer)/portal/profile/page";

describe("CustomerProfilePage", () => {
  beforeEach(() => {
    authMocks.requireCustomer.mockResolvedValue({
      customerId: "customer-1",
      userId: "user-1",
    });
    queryMocks.getCustomerSelfProfile.mockResolvedValue({
      account: {
        createdAt: new Date("2026-06-12T04:30:00.000Z"),
        displayName: "陆天",
        email: "customer@example.com",
        emailVerified: true,
      },
      customer: {
        code: "003",
        name: "陆天",
        status: "ACTIVE",
      },
      stores: [
        {
          externalStoreCode: "TEMU-OTTAWA-01",
          id: "store-1",
          name: "陆天一店",
          platform: "TEMU",
          status: "ACTIVE",
        },
        {
          externalStoreCode: null,
          id: "store-2",
          name: "陆天二店",
          platform: "TEMU",
          status: "DISABLED",
        },
      ],
    });
    walletMocks.getWalletPosition.mockResolvedValue({
      activeHoldFen: 3_800,
      availableFen: 16_200,
      balanceFen: 20_000,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads only the authenticated customer's profile and presents its account binding", async () => {
    render(await CustomerProfilePage());

    expect(authMocks.requireCustomer).toHaveBeenCalledOnce();
    expect(queryMocks.getCustomerSelfProfile).toHaveBeenCalledWith({
      customerId: "customer-1",
      userId: "user-1",
    });
    expect(walletMocks.getWalletPosition).toHaveBeenCalledWith("customer-1");
    expect(screen.getByRole("heading", { level: 1, name: "个人中心" })).toBeVisible();
    expect(screen.getByText("陆天", { selector: "h2" })).toBeVisible();
    expect(screen.getByText("客户编号 003")).toBeVisible();
    expect(screen.getByText("customer@example.com")).toBeVisible();
    expect(screen.getByText("陆天一店")).toBeVisible();
    expect(screen.getByText("陆天二店")).toBeVisible();
    expect(screen.getByText("2 家店铺")).toBeVisible();
    expect(screen.getByText("¥162.00")).toBeVisible();
    expect(screen.getByText("¥38.00")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看资金明细" })).toHaveAttribute(
      "href",
      "/portal/wallet",
    );
    const securityPanel = screen.getByRole("heading", { level: 2, name: "账号安全" }).closest("section");
    expect(securityPanel).toHaveClass("bg-white");
    expect(securityPanel).not.toHaveClass("bg-[var(--portal-focus-surface)]");
    expect(screen.getByText("已停用")).toBeVisible();
    expect(screen.getByText("账号正常")).toBeVisible();
    expect(screen.queryByText("CUSTOMER")).not.toBeInTheDocument();
    expect(screen.queryByText("DISABLED")).not.toBeInTheDocument();
  });

  it("does not claim that an unverified account is normal", async () => {
    queryMocks.getCustomerSelfProfile.mockResolvedValueOnce({
      account: {
        createdAt: new Date("2026-06-12T04:30:00.000Z"),
        displayName: "陆天",
        email: "customer@example.com",
        emailVerified: false,
      },
      customer: {
        code: "003",
        name: "陆天",
        status: "ACTIVE",
      },
      stores: [],
    });

    render(await CustomerProfilePage());

    expect(screen.getByText("邮箱未验证")).toBeVisible();
    expect(screen.queryByText("账号正常")).not.toBeInTheDocument();
  });
});
