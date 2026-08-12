import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  createAdminAccount: vi.fn(),
  resetManagedAccountPassword: vi.fn(),
  setManagedAccountStatus: vi.fn(),
  updateManagedAccount: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/accounts/service", () => {
  return {
    createAdminAccount: serviceMocks.createAdminAccount,
    resetManagedAccountPassword: serviceMocks.resetManagedAccountPassword,
    setManagedAccountStatus: serviceMocks.setManagedAccountStatus,
    updateManagedAccount: serviceMocks.updateManagedAccount,
  };
});

import {
  createAdminAccountAction,
  setManagedAccountStatusAction,
  updateManagedAccountAction,
} from "@/modules/accounts/actions";

describe("account management actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    guardMocks.requireSuperAdmin.mockReset();
    serviceMocks.createAdminAccount.mockReset();
    serviceMocks.resetManagedAccountPassword.mockReset();
    serviceMocks.setManagedAccountStatus.mockReset();
    serviceMocks.updateManagedAccount.mockReset();

    guardMocks.requireSuperAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
  });

  it("returns a safe duplicate-email error when creating an admin with an existing login email", async () => {
    serviceMocks.createAdminAccount.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        cause: {
          code: "23505",
          constraint_name: "auth_users_email_unique",
        },
      }),
    );

    const formData = new FormData();
    formData.set("displayName", "值班管理员");
    formData.set("email", "ops@test.local");
    formData.set("password", "valid-admin-password-2026");
    formData.set("reason", "新增值班账号");

    const result = await createAdminAccountAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "登录邮箱已存在，请更换后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a safe stale-record error when updating an account that no longer exists", async () => {
    serviceMocks.updateManagedAccount.mockRejectedValue(
      Object.assign(new Error("Account not found"), {
        code: "ACCOUNT_NOT_FOUND",
        name: "AccountGovernanceError",
      }),
    );

    const formData = new FormData();
    formData.set("userId", "missing-user-id");
    formData.set("displayName", "运营管理员");
    formData.set("email", "ops-updated@test.local");
    formData.set("reason", "同步资料");

    const result = await updateManagedAccountAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "账号记录不存在，页面可能已过期，请刷新后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a protected-account error when trying to disable the bootstrap super admin", async () => {
    serviceMocks.setManagedAccountStatus.mockRejectedValue(
      Object.assign(new Error("The super admin cannot be disabled"), {
        code: "SUPER_ADMIN_IMMUTABLE",
        name: "AccountGovernanceError",
      }),
    );

    const formData = new FormData();
    formData.set("userId", "bootstrap-super-admin");
    formData.set("status", "DISABLED");
    formData.set("reason", "should fail");

    const result = await setManagedAccountStatusAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "受保护的超级管理员不支持此操作。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });
});
