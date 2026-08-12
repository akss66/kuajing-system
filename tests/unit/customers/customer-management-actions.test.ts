import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
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

    expect(result).toEqual({ status: "success" });
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

    expect(result).toEqual({ status: "success" });
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

    expect(result).toEqual({ status: "success" });
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

    expect(result).toEqual({ status: "success" });
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

  it("updates a store through the service and revalidates the customer detail page", async () => {
    const formData = new FormData();
    formData.set("customerId", "66666666-6666-4666-8666-666666666666");
    formData.set("storeId", "77777777-7777-4777-8777-777777777777");
    formData.set("name", "Updated Store");
    formData.set("platform", "TEMU");
    formData.set("externalStoreCode", "TEMU-777");
    formData.set("reason", "Refresh store metadata");

    const result = await updateStoreAction({ status: "idle" }, formData);

    expect(result).toEqual({ status: "success" });
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

  it("still provisions customer creation through the existing action path", async () => {
    const formData = new FormData();
    formData.set("code", "NEW-CUSTOMER");
    formData.set("customerName", "Provisioned Customer");
    formData.set("email", "new-customer@test.local");
    formData.set("password", "valid-customer-password-2026");
    formData.set("storeName", "First Store");

    const result = await createCustomerWithStoreAction({ status: "idle" }, formData);

    expect(result.status).toBe("success");
    expect(serviceMocks.provisionCustomerWithStore).toHaveBeenCalledWith({
      actorId: "super-admin-auth-user",
      code: "NEW-CUSTOMER",
      customerName: "Provisioned Customer",
      email: "new-customer@test.local",
      password: "valid-customer-password-2026",
      storeName: "First Store",
    });
  });
});
