import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelAllCancellableOrderShipments: vi.fn(),
  completeAllOfflineOrderRefunds: vi.fn(),
  completeOfflinePackageRefund: vi.fn(),
  getEnabledJifengCancellationClient: vi.fn(),
  getJifengReadClient: vi.fn(),
  refreshAllJifengShipmentStatuses: vi.fn(),
  refreshJifengShipmentStatus: vi.fn(),
  revalidatePath: vi.fn(),
  requireAdmin: vi.fn(),
  resolveAdminUserId: vi.fn(),
  retryJifengShipment: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/modules/identity/guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/modules/identity/admin-profile", () => ({
  resolveAdminUserId: mocks.resolveAdminUserId,
}));
vi.mock("@/modules/jifeng-connection/provider", () => ({
  getEnabledJifengCancellationClient: mocks.getEnabledJifengCancellationClient,
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
  cancelAllCancellableOrderShipmentsAction,
  completeAllOfflineOrderRefundsAction,
  completeOfflinePackageRefundAction,
  refreshAllJifengShipmentStatusesAction,
  refreshJifengShipmentStatusAction,
  retryJifengShipmentAction,
} from "@/modules/fulfillment/actions";
import { JifengStatusRefreshError } from "@/modules/fulfillment/status-sync";

describe("fulfillment actions", () => {
  beforeEach(() => {
    mocks.cancelAllCancellableOrderShipments.mockReset();
    mocks.completeAllOfflineOrderRefunds.mockReset();
    mocks.completeOfflinePackageRefund.mockReset();
    mocks.getEnabledJifengCancellationClient.mockReset();
    mocks.getJifengReadClient.mockReset();
    mocks.refreshAllJifengShipmentStatuses.mockReset();
    mocks.refreshJifengShipmentStatus.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.requireAdmin.mockReset();
    mocks.requireAdmin.mockResolvedValue({ userId: "admin-user" });
    mocks.resolveAdminUserId.mockReset();
    mocks.resolveAdminUserId.mockResolvedValue("admin-profile");
    mocks.retryJifengShipment.mockReset();
  });

  it("reports the safe platform order numbers for a partial whole-order status refresh", async () => {
    const client = { getOrder: vi.fn() };
    mocks.getJifengReadClient.mockResolvedValueOnce({ client });
    mocks.refreshAllJifengShipmentStatuses.mockResolvedValueOnce({
      failedCount: 2,
      items: [
        {
          externalOrderNo: "PO-037-SUCCEEDED",
          outcome: "REFRESHED",
          shipmentId: "00000000-0000-4000-8000-000000000001",
        },
        {
          externalOrderNo: "PO-037-FAILED",
          outcome: "FAILED",
          shipmentId: "00000000-0000-4000-8000-000000000002",
        },
        {
          externalOrderNo: "customer@example.com\nprivate detail",
          outcome: "FAILED",
          shipmentId: "00000000-0000-4000-8000-000000000003",
        },
      ],
      refreshedCount: 1,
      skippedCount: 0,
    });
    const formData = new FormData();
    formData.set("orderId", "00000000-0000-4000-8000-000000000010");

    const result = await refreshAllJifengShipmentStatusesAction(
      { status: "idle" },
      formData,
    );

    expect(result).toEqual({
      message:
        "整单状态查询完成：已更新 1 个，跳过 0 个，失败 2 个。失败包裹：PO-037-FAILED、包裹序号 3。",
      status: "error",
    });
    expect(result.message).not.toContain("00000000-0000-4000-8000-000000000002");
    expect(result.message).not.toContain("customer@example.com");
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.refreshAllJifengShipmentStatuses).toHaveBeenCalledWith({
      client,
      orderId: "00000000-0000-4000-8000-000000000010",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/orders/00000000-0000-4000-8000-000000000010",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/orders");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/inventory");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it("rejects an invalid whole-order status refresh before acquiring a client", async () => {
    const formData = new FormData();
    formData.set("orderId", "not-an-order-id");

    await expect(
      refreshAllJifengShipmentStatusesAction({ status: "idle" }, formData),
    ).resolves.toEqual({ message: "拿货单信息无效。", status: "error" });
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.getJifengReadClient).not.toHaveBeenCalled();
    expect(mocks.refreshAllJifengShipmentStatuses).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not run a whole-order status refresh when admin authorization fails", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const formData = new FormData();
    formData.set("orderId", "00000000-0000-4000-8000-000000000010");

    await expect(
      refreshAllJifengShipmentStatusesAction({ status: "idle" }, formData),
    ).rejects.toThrow("FORBIDDEN");
    expect(mocks.getJifengReadClient).not.toHaveBeenCalled();
    expect(mocks.refreshAllJifengShipmentStatuses).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("reports failed platform orders and preserves all counts for a partial whole-order cancellation", async () => {
    mocks.cancelAllCancellableOrderShipments.mockResolvedValueOnce({
      cancelledCount: 1,
      failedCount: 1,
      items: [
        {
          externalOrderNo: "PO-037-CANCELLED",
          outcome: "CANCELLED",
          shipmentId: "00000000-0000-4000-8000-000000000001",
        },
        {
          externalOrderNo: "PO-037-PENDING",
          outcome: "PENDING",
          shipmentId: "00000000-0000-4000-8000-000000000002",
        },
        {
          externalOrderNo: "PO-037-SKIPPED",
          outcome: "SKIPPED",
          shipmentId: "00000000-0000-4000-8000-000000000003",
        },
        {
          externalOrderNo: "PO-037-FAILED",
          outcome: "FAILED",
          shipmentId: "00000000-0000-4000-8000-000000000004",
        },
      ],
      orderStatus: "FULFILLING",
      pendingCount: 1,
      skippedCount: 1,
    });
    const formData = new FormData();
    formData.set("orderId", "00000000-0000-4000-8000-000000000010");
    formData.set("reason", "  客户确认整单取消  ");

    await expect(
      cancelAllCancellableOrderShipmentsAction({ status: "idle" }, formData),
    ).resolves.toEqual({
      message:
        "整单取消处理完成：已取消 1 个，等待极风确认 1 个，跳过 1 个，失败 1 个。失败包裹：PO-037-FAILED。",
      status: "error",
    });
    expect(mocks.cancelAllCancellableOrderShipments).toHaveBeenCalledWith({
      actorUserId: "admin-user",
      getClient: expect.any(Function),
      orderId: "00000000-0000-4000-8000-000000000010",
      reason: "客户确认整单取消",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/portal/orders/00000000-0000-4000-8000-000000000010",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/payments");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/portal/wallet");
  });

  it("rejects invalid whole-order cancellation input before calling the operation", async () => {
    const formData = new FormData();
    formData.set("orderId", "not-an-order-id");
    formData.set("reason", "x");

    const result = await cancelAllCancellableOrderShipmentsAction(
      { status: "idle" },
      formData,
    );

    expect(result.status).toBe("error");
    expect(result.fieldErrors).toMatchObject({ orderId: expect.any(Array), reason: expect.any(Array) });
    expect(mocks.cancelAllCancellableOrderShipments).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not run whole-order cancellation when admin authorization fails", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const formData = new FormData();
    formData.set("orderId", "00000000-0000-4000-8000-000000000010");
    formData.set("reason", "客户确认整单取消");

    await expect(
      cancelAllCancellableOrderShipmentsAction({ status: "idle" }, formData),
    ).rejects.toThrow("FORBIDDEN");
    expect(mocks.cancelAllCancellableOrderShipments).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("validates and refreshes all financial views after confirming all offline refunds", async () => {
    mocks.completeAllOfflineOrderRefunds.mockResolvedValueOnce({
      completedAmountFen: 1700,
      completedCount: 2,
      status: "COMPLETED",
    });
    const formData = new FormData();
    formData.set("orderId", "00000000-0000-4000-8000-000000000010");
    formData.set("note", "  微信退款流水号 WX-20260825  ");

    await expect(
      completeAllOfflineOrderRefundsAction({ status: "idle" }, formData),
    ).resolves.toEqual({
      message: "已确认 2 笔线下退款，共 17.00 元，并写入审计记录。",
      status: "success",
    });
    expect(mocks.resolveAdminUserId).toHaveBeenCalledWith("admin-user");
    expect(mocks.completeAllOfflineOrderRefunds).toHaveBeenCalledWith({
      actorUserId: "admin-user",
      adminUserId: "admin-profile",
      note: "微信退款流水号 WX-20260825",
      orderId: "00000000-0000-4000-8000-000000000010",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/portal/orders/00000000-0000-4000-8000-000000000010",
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/payments");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/portal/wallet");
  });

  it("rejects invalid whole-order refund input without resolving an admin profile", async () => {
    const formData = new FormData();
    formData.set("orderId", "not-an-order-id");
    formData.set("note", "x");

    const result = await completeAllOfflineOrderRefundsAction(
      { status: "idle" },
      formData,
    );

    expect(result.status).toBe("error");
    expect(result.fieldErrors).toMatchObject({ orderId: expect.any(Array), note: expect.any(Array) });
    expect(mocks.resolveAdminUserId).not.toHaveBeenCalled();
    expect(mocks.completeAllOfflineOrderRefunds).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not run whole-order refund completion when admin authorization fails", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const formData = new FormData();
    formData.set("orderId", "00000000-0000-4000-8000-000000000010");
    formData.set("note", "微信退款流水号 WX-20260825");

    await expect(
      completeAllOfflineOrderRefundsAction({ status: "idle" }, formData),
    ).rejects.toThrow("FORBIDDEN");
    expect(mocks.resolveAdminUserId).not.toHaveBeenCalled();
    expect(mocks.completeAllOfflineOrderRefunds).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
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
