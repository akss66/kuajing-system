import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retryJifengShipment: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-user" }),
}));
vi.mock("@/modules/identity/admin-profile", () => ({
  resolveAdminUserId: vi.fn().mockResolvedValue("admin-profile"),
}));
vi.mock("@/modules/jifeng-connection/provider", () => ({
  getEnabledJifengWriteClient: vi.fn(),
}));
vi.mock("@/modules/fulfillment/dispatch", () => ({
  JifengDispatchError: class JifengDispatchError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  retryJifengShipment: mocks.retryJifengShipment,
}));
vi.mock("@/modules/fulfillment/replacement", () => ({
  ReplacementError: class ReplacementError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  cancelJifengShipment: vi.fn(),
  createReplacementRequest: vi.fn(),
}));

import { retryJifengShipmentAction } from "@/modules/fulfillment/actions";

describe("fulfillment actions", () => {
  beforeEach(() => {
    mocks.retryJifengShipment.mockReset();
  });

  it("does not expose an unexpected infrastructure error to the administrator", async () => {
    mocks.retryJifengShipment.mockRejectedValueOnce(
      new Error("duplicate key value violates private_constraint"),
    );
    const formData = new FormData();
    formData.set("orderId", "order-1");
    formData.set("reason", "运营确认重试");
    formData.set("shipmentId", "00000000-0000-4000-8000-000000000001");

    await expect(retryJifengShipmentAction({ status: "idle" }, formData)).resolves.toEqual({
      message: "极风重试提交失败。",
      status: "error",
    });
  });
});
