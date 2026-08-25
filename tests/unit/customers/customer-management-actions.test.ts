import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSuperAdmin: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  provisionCustomerWithStore: vi.fn(),
  setCustomerStatus: vi.fn(),
  setStoreStatus: vi.fn(),
  updateCustomer: vi.fn(),
  updateStore: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/customers/service", () => serviceMocks);

import {
  createCustomerWithStoreAction,
  createStoreAction,
  setCustomerStatusAction,
  setStoreStatusAction,
  updateCustomerAction,
  updateStoreAction,
} from "@/modules/customers/actions";

describe("customer management actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    guardMocks.requireAdmin.mockReset();
    guardMocks.requireSuperAdmin.mockReset();
    serviceMocks.createStore.mockReset();
    serviceMocks.provisionCustomerWithStore.mockReset();
    serviceMocks.setCustomerStatus.mockReset();
    serviceMocks.setStoreStatus.mockReset();
    serviceMocks.updateCustomer.mockReset();
    serviceMocks.updateStore.mockReset();

    guardMocks.requireAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
    guardMocks.requireSuperAdmin.mockResolvedValue({
      kind: "SUPER_ADMIN",
      userId: "super-admin-auth-user",
    });
  });

  it("requires an administrator to provision a customer login account", async () => {
    guardMocks.requireAdmin.mockRejectedValue(
      Object.assign(new Error("FORBIDDEN_ADMIN"), { code: "FORBIDDEN_ADMIN" }),
    );
    const formData = new FormData();
    formData.set("code", "NEW-CUSTOMER");
    formData.set("customerName", "Provisioned Customer");
    formData.set("email", "new-customer@test.local");
    formData.set("password", "valid-customer-password-2026");
    formData.set("reason", "Open the first managed storefront");
    formData.set("storeName", "First Store");

    await expect(
      createCustomerWithStoreAction({ status: "idle" }, formData),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ADMIN" });
    expect(serviceMocks.provisionCustomerWithStore).not.toHaveBeenCalled();
  });

  it("requires an administrator to change customer login status", async () => {
    guardMocks.requireAdmin.mockRejectedValue(
      Object.assign(new Error("FORBIDDEN_ADMIN"), { code: "FORBIDDEN_ADMIN" }),
    );
    const formData = new FormData();
    formData.set("customerId", "55555555-5555-4555-8555-555555555555");
    formData.set("status", "DISABLED");
    formData.set("reason", "Compliance hold");

    await expect(
      setCustomerStatusAction({ status: "idle" }, formData),
    ).rejects.toMatchObject({ code: "FORBIDDEN_ADMIN" });
    expect(serviceMocks.setCustomerStatus).not.toHaveBeenCalled();
  });

  it("forwards customer updates to the service and revalidates the customer screens", async () => {
    const formData = new FormData();
    formData.set("customerId", "11111111-1111-4111-8111-111111111111");
    formData.set("code", "UPDATED-CUSTOMER");
    formData.set("name", "Updated Customer");
    formData.set("contactName", "Alice");
    formData.set("contactWechat", "alice-wechat");
    formData.set("reason", "Normalize customer record");

    const result = await updateCustomerAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "客户资料已更新。", status: "success" });
    expect(serviceMocks.updateCustomer).toHaveBeenCalledWith({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      code: "UPDATED-CUSTOMER",
      contactName: "Alice",
      contactWechat: "alice-wechat",
      customerId: "11111111-1111-4111-8111-111111111111",
      name: "Updated Customer",
      reason: "Normalize customer record",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/customers");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/customers/11111111-1111-4111-8111-111111111111",
    );
  });

  it("creates stores through the service and revalidates the customer detail page", async () => {
    const formData = new FormData();
    formData.set("customerId", "22222222-2222-4222-8222-222222222222");
    formData.set("name", "New TEMU Store");
    formData.set("platform", "TEMU");
    formData.set("externalStoreCode", "TEMU-001");
    formData.set("reason", "Open a second storefront");

    const result = await createStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "店铺已新增。", status: "success" });
    expect(serviceMocks.createStore).toHaveBeenCalledWith({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      customerId: "22222222-2222-4222-8222-222222222222",
      externalStoreCode: "TEMU-001",
      name: "New TEMU Store",
      platform: "TEMU",
      reason: "Open a second storefront",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/customers");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/customers/22222222-2222-4222-8222-222222222222",
    );
  });

  it("disables a store through the service and keeps customer pages fresh", async () => {
    const formData = new FormData();
    formData.set("customerId", "33333333-3333-4333-8333-333333333333");
    formData.set("storeId", "44444444-4444-4444-8444-444444444444");
    formData.set("status", "DISABLED");
    formData.set("reason", "Pause new orders");

    const result = await setStoreStatusAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "店铺已停用。", status: "success" });
    expect(serviceMocks.setStoreStatus).toHaveBeenCalledWith({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      reason: "Pause new orders",
      status: "DISABLED",
      storeId: "44444444-4444-4444-8444-444444444444",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/customers");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/customers/33333333-3333-4333-8333-333333333333",
    );
  });

  it("disables a customer through the service and revalidates the list plus detail page", async () => {
    const formData = new FormData();
    formData.set("customerId", "55555555-5555-4555-8555-555555555555");
    formData.set("status", "DISABLED");
    formData.set("reason", "Compliance hold");

    const result = await setCustomerStatusAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "客户已停用。", status: "success" });
    expect(serviceMocks.setCustomerStatus).toHaveBeenCalledWith({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      customerId: "55555555-5555-4555-8555-555555555555",
      reason: "Compliance hold",
      status: "DISABLED",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/customers");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/customers/55555555-5555-4555-8555-555555555555",
    );
  });

  it("allows an ordinary administrator to disable a customer account", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "ordinary-admin-auth-user",
    });
    const formData = new FormData();
    formData.set("customerId", "55555555-5555-4555-8555-555555555555");
    formData.set("status", "DISABLED");
    formData.set("reason", "Pause customer operations");

    const result = await setCustomerStatusAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "客户已停用。", status: "success" });
    expect(serviceMocks.setCustomerStatus).toHaveBeenCalledWith({
      actor: { kind: "ADMIN", userId: "ordinary-admin-auth-user" },
      customerId: "55555555-5555-4555-8555-555555555555",
      reason: "Pause customer operations",
      status: "DISABLED",
    });
  });

  it("updates a store through the service and revalidates the customer detail page", async () => {
    const formData = new FormData();
    formData.set("customerId", "66666666-6666-4666-8666-666666666666");
    formData.set("storeId", "77777777-7777-4777-8777-777777777777");
    formData.set("name", "Updated Store");
    formData.set("platform", "TEMU");
    formData.set("externalStoreCode", "TEMU-777");
    formData.set("reason", "Refresh store metadata");

    const result = await updateStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "店铺资料已更新。", status: "success" });
    expect(serviceMocks.updateStore).toHaveBeenCalledWith({
      actor: { kind: "SUPER_ADMIN", userId: "super-admin-auth-user" },
      externalStoreCode: "TEMU-777",
      name: "Updated Store",
      platform: "TEMU",
      reason: "Refresh store metadata",
      storeId: "77777777-7777-4777-8777-777777777777",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith("/admin/customers");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/customers/66666666-6666-4666-8666-666666666666",
    );
  });

  it("allows an ordinary administrator to provision a customer through the existing action path", async () => {
    guardMocks.requireAdmin.mockResolvedValue({
      kind: "ADMIN",
      userId: "ordinary-admin-auth-user",
    });
    const formData = new FormData();
    formData.set("code", "NEW-CUSTOMER");
    formData.set("customerName", "Provisioned Customer");
    formData.set("email", "new-customer@test.local");
    formData.set("password", "valid-customer-password-2026");
    formData.set("reason", "Open the first managed storefront");
    formData.set("storeName", "First Store");

    const result = await createCustomerWithStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({ message: "客户与首家店铺已创建。", status: "success" });
    expect(serviceMocks.provisionCustomerWithStore).toHaveBeenCalledWith({
      actor: { kind: "ADMIN", userId: "ordinary-admin-auth-user" },
      code: "NEW-CUSTOMER",
      customerName: "Provisioned Customer",
      email: "new-customer@test.local",
      password: "valid-customer-password-2026",
      reason: "Open the first managed storefront",
      storeName: "First Store",
    });
  });

  it("requires a reason before provisioning a new customer account", async () => {
    const formData = new FormData();
    formData.set("code", "NEW-CUSTOMER");
    formData.set("customerName", "Provisioned Customer");
    formData.set("email", "new-customer@test.local");
    formData.set("password", "valid-customer-password-2026");
    formData.set("storeName", "First Store");

    const result = await createCustomerWithStoreAction({ status: "idle" }, formData);

    expect(result.status).toBe("error");
    expect(result.fieldErrors).toMatchObject({
      reason: expect.any(Array),
    });
    expect(serviceMocks.provisionCustomerWithStore).not.toHaveBeenCalled();
  });

  it("returns Chinese business validation messages for every customer creation field", async () => {
    const formData = new FormData();
    formData.set("code", "2");
    formData.set("customerName", "A");
    formData.set("email", "not-an-email");
    formData.set("password", "short");
    formData.set("reason", "");
    formData.set("storeName", "B");

    const result = await createCustomerWithStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({
      fieldErrors: {
        code: ["客户编号至少需要 2 个字符。"],
        customerName: ["客户名称至少需要 2 个字符。"],
        email: ["请输入有效的登录邮箱。"],
        password: ["初始密码至少需要 12 个字符。"],
        reason: ["请输入创建原因。"],
        storeName: ["店铺名称至少需要 2 个字符。"],
      },
      status: "error",
    });
    expect(JSON.stringify(result)).not.toMatch(/Too small|Invalid/i);
    expect(serviceMocks.provisionCustomerWithStore).not.toHaveBeenCalled();
  });

  it("returns a safe duplicate constraint error when provisioning a customer with an existing code, store, or email", async () => {
    serviceMocks.provisionCustomerWithStore.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        cause: {
          code: "23505",
          constraint_name: "customers_code_unique",
        },
      }),
    );

    const formData = new FormData();
    formData.set("code", "EXISTING-CUSTOMER");
    formData.set("customerName", "Existing Customer");
    formData.set("email", "existing-customer@test.local");
    formData.set("password", "valid-customer-password-2026");
    formData.set("reason", "Attempt duplicate provisioning");
    formData.set("storeName", "Existing Store");

    const result = await createCustomerWithStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "客户编号、店铺名称或登录邮箱已存在，请核对后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a safe stale-customer error when the customer profile no longer exists", async () => {
    serviceMocks.updateCustomer.mockRejectedValue(
      Object.assign(new Error("Customer not found"), {
        code: "CUSTOMER_NOT_FOUND",
        name: "CustomerManagementError",
      }),
    );

    const formData = new FormData();
    formData.set("customerId", "11111111-1111-4111-8111-111111111111");
    formData.set("code", "UPDATED-CUSTOMER");
    formData.set("name", "Updated Customer");
    formData.set("reason", "Refresh profile");

    const result = await updateCustomerAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "客户记录不存在，页面可能已过期，请刷新后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a safe duplicate store error when creating a store with an existing name", async () => {
    serviceMocks.createStore.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        cause: {
          code: "23505",
          constraint_name: "stores_customer_name_unique",
        },
      }),
    );

    const formData = new FormData();
    formData.set("customerId", "22222222-2222-4222-8222-222222222222");
    formData.set("name", "North Store");
    formData.set("platform", "TEMU");
    formData.set("externalStoreCode", "TEMU-NORTH-001");
    formData.set("reason", "Add duplicate store");

    const result = await createStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "该客户下已存在同名店铺，请调整后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a safe stale-store error when updating a store that no longer exists", async () => {
    serviceMocks.updateStore.mockRejectedValue(
      Object.assign(new Error("Store not found"), {
        code: "STORE_NOT_FOUND",
        name: "CustomerManagementError",
      }),
    );

    const formData = new FormData();
    formData.set("customerId", "66666666-6666-4666-8666-666666666666");
    formData.set("storeId", "77777777-7777-4777-8777-777777777777");
    formData.set("name", "Updated Store");
    formData.set("platform", "TEMU");
    formData.set("externalStoreCode", "TEMU-777");
    formData.set("reason", "Refresh store metadata");

    const result = await updateStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({
      message: "店铺记录不存在，页面可能已过期，请刷新后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows an unknown 23505 customer duplication error when no allowlisted constraint name is present", async () => {
    serviceMocks.provisionCustomerWithStore.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        cause: {
          code: "23505",
        },
      }),
    );

    const formData = new FormData();
    formData.set("code", "EXISTING-CUSTOMER");
    formData.set("customerName", "Existing Customer");
    formData.set("email", "existing-customer@test.local");
    formData.set("password", "valid-customer-password-2026");
    formData.set("reason", "Attempt duplicate provisioning");
    formData.set("storeName", "Existing Store");

    await expect(createCustomerWithStoreAction({ status: "idle" }, formData)).rejects.toThrow(
      "duplicate key value violates unique constraint",
    );
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows a customer duplication error that only mentions unique constraint text without metadata", async () => {
    serviceMocks.createStore.mockRejectedValue(
      new Error("some unique constraint text without a known constraint name"),
    );

    const formData = new FormData();
    formData.set("customerId", "22222222-2222-4222-8222-222222222222");
    formData.set("name", "North Store");
    formData.set("platform", "TEMU");
    formData.set("externalStoreCode", "TEMU-NORTH-001");
    formData.set("reason", "Add duplicate store");

    await expect(createStoreAction({ status: "idle" }, formData)).rejects.toThrow(
      "some unique constraint text without a known constraint name",
    );
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });
});
