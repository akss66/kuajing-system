import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelAllCancellableOrderShipments: vi.fn(),
  completeAllOfflineOrderRefunds: vi.fn(),
  completeOfflinePackageRefund: vi.fn(),
  getJifengReadClient: vi.fn(),
  refreshAllJifengShipmentStatuses: vi.fn(),
  refreshJifengShipmentStatus: vi.fn(),
  revalidatePath: vi.fn(),
  retryJifengShipment: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ userId: "admin-user" }),
}));
vi.mock("@/modules/identity/admin-profile", () => ({
  resolveAdminUserId: vi.fn().mockResolvedValue("admin-profile"),
}));
vi.mock("@/modules/jifeng-connection/provider", () => ({
  getEnabledJifengCancellationClient: vi.fn(),
  getJifengReadClient: mocks.getJifengReadClient,
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
vi.mock("@/modules/fulfillment/package-cancellation-adjustment", () => ({
  completeOfflinePackageRefund: mocks.completeOfflinePackageRefund,
}));
vi.mock("@/modules/fulfillment/order-operations", () => ({
  OrderOperationsError: class OrderOperationsError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  cancelAllCancellableOrderShipments: mocks.cancelAllCancellableOrderShipments,
  completeAllOfflineOrderRefunds: mocks.completeAllOfflineOrderRefunds,
  refreshAllJifengShipmentStatuses: mocks.refreshAllJifengShipmentStatuses,
}));
vi.mock("@/modules/fulfillment/status-sync", () => ({
  JifengStatusRefreshError: class JifengStatusRefreshError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  refreshJifengShipmentStatus: mocks.refreshJifengShipmentStatus,
}));
vi.mock("@/modules/settlement/batch-service", () => ({
  SettlementBatchError: class SettlementBatchError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import {
  completeOfflinePackageRefundAction,
  refreshJifengShipmentStatusAction,
  retryJifengShipmentAction,
} from "@/modules/fulfillment/actions";
import { JifengStatusRefreshError } from "@/modules/fulfillment/status-sync";

describe("fulfillment actions", () => {
  beforeEach(() => {
    mocks.cancelAllCancellableOrderShipments.mockReset();
    mocks.completeAllOfflineOrderRefunds.mockReset();
    mocks.completeOfflinePackageRefund.mockReset();
    mocks.getJifengReadClient.mockReset();
    mocks.refreshAllJifengShipmentStatuses.mockReset();
    mocks.refreshJifengShipmentStatus.mockReset();
    mocks.revalidatePath.mockReset();
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

  it("revalidates the trusted order returned by the refund service", async () => {
    mocks.completeOfflinePackageRefund.mockResolvedValueOnce({
      orderId: "trusted-order",
      status: "COMPLETED",
    });
    const formData = new FormData();
    formData.set("adjustmentId", "00000000-0000-4000-8000-000000000001");
    formData.set("note", "微信退款凭证");
    formData.set("orderId", "untrusted-order");

    await expect(
      completeOfflinePackageRefundAction({ status: "idle" }, formData),
    ).resolves.toMatchObject({ status: "success" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/orders/trusted-order",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/portal/orders/trusted-order",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalledWith(
      expect.stringContaining("untrusted-order"),
    );
  });

  it("revalidates the trusted order returned by an immediate Jifeng status refresh", async () => {
    const client = { getOrder: vi.fn() };
    mocks.getJifengReadClient.mockResolvedValueOnce({ client });
    mocks.refreshJifengShipmentStatus.mockResolvedValueOnce({
      orderId: "trusted-refreshed-order",
      orderStatus: "CANCELLED",
      status: "ALREADY_CANCELLED",
    });
    const formData = new FormData();
    formData.set("orderId", "untrusted-order");
    formData.set("shipmentId", "00000000-0000-4000-8000-000000000001");

    await expect(
      refreshJifengShipmentStatusAction({ status: "idle" }, formData),
    ).resolves.toEqual({
      message: "已重新核对极风状态，取消状态和父拿货单进度已同步。",
      status: "success",
    });
    expect(mocks.refreshJifengShipmentStatus).toHaveBeenCalledWith({
      client,
      shipmentId: "00000000-0000-4000-8000-000000000001",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/orders/trusted-refreshed-order",
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalledWith(
      expect.stringContaining("untrusted-order"),
    );
  });

  it.each([
    ["FULFILLMENT_NOT_FOUND", "未找到该包裹的极风履约记录。"],
    ["STATUS_REFRESH_IN_PROGRESS", "该包裹正在同步极风状态，请稍后再试。"],
    ["STATUS_NOT_REFRESHABLE", "当前包裹还不能直接查询极风状态。"],
    ["STATUS_REFRESH_STALE", "本次极风状态查询已过期，请重新查询。"],
  ])("maps refresh error %s to safe operator copy", async (code, message) => {
    const client = { getOrder: vi.fn() };
    mocks.getJifengReadClient.mockResolvedValueOnce({ client });
    mocks.refreshJifengShipmentStatus.mockRejectedValueOnce(
      new JifengStatusRefreshError(
        code,
        "当前履约状态 SUBMITTING 不能立即查询极风",
      ),
    );
    const formData = new FormData();
    formData.set("shipmentId", "00000000-0000-4000-8000-000000000001");

    await expect(
      refreshJifengShipmentStatusAction({ status: "idle" }, formData),
    ).resolves.toEqual({
      message,
      status: "error",
    });
  });
});
