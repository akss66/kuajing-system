import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  authorizeJifengConnection: vi.fn(),
  disconnectJifengConnection: vi.fn(),
  discoverJifengResources: vi.fn(),
  runStoredJifengDiagnostic: vi.fn(),
  selectJifengResources: vi.fn(),
  setJifengFulfillmentEnabled: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/jifeng-connection/service", () => serviceMocks);

import {
  authorizeJifengConnectionAction,
  disconnectJifengConnectionAction,
  discoverJifengResourcesAction,
  runJifengDiagnosticAction,
  selectJifengResourcesAction,
  setJifengFulfillmentAction,
} from "@/modules/jifeng-connection/actions";

const actor = {
  kind: "SUPER_ADMIN" as const,
  userId: "super-admin-user",
};

function form(entries: Record<string, string> = {}) {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}

const validAuthorization = () =>
  form({
    email: "owner@example.test",
    oneTimeToken: "one-time-token-1234",
  });

describe("Jifeng connection actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    guardMocks.requireSuperAdmin.mockReset();
    for (const service of Object.values(serviceMocks)) service.mockReset();

    guardMocks.requireSuperAdmin.mockResolvedValue(actor);
    serviceMocks.authorizeJifengConnection.mockResolvedValue(undefined);
    serviceMocks.disconnectJifengConnection.mockResolvedValue(undefined);
    serviceMocks.discoverJifengResources.mockResolvedValue({
      logistics: [
        { code: "CA_POST", id: 7, name: "加拿大邮政" },
      ],
      warehouses: [
        { code: "CA-1", country: "CA", name: "加拿大一号仓" },
      ],
    });
    serviceMocks.runStoredJifengDiagnostic.mockResolvedValue({
      ok: true,
      ranAt: new Date("2026-08-13T08:00:00.000Z"),
    });
    serviceMocks.selectJifengResources.mockResolvedValue(undefined);
    serviceMocks.setJifengFulfillmentEnabled.mockResolvedValue(undefined);
  });

  it.each([
    ["authorize", authorizeJifengConnectionAction, validAuthorization()],
    ["discover", discoverJifengResourcesAction, form()],
    [
      "select",
      selectJifengResourcesAction,
      form({ logisticsId: "7", warehouseCode: "CA-1" }),
    ],
    ["diagnostic", runJifengDiagnosticAction, form()],
    [
      "fulfillment",
      setJifengFulfillmentAction,
      form({ enabled: "true", reason: "批准生产履约" }),
    ],
    [
      "disconnect",
      disconnectJifengConnectionAction,
      form({ reason: "轮换授权负责人" }),
    ],
  ])("requires a fresh super-admin check before the %s action", async (_name, action, data) => {
    const accessError = Object.assign(new Error("FORBIDDEN_ADMIN"), {
      code: "FORBIDDEN_ADMIN",
      status: 403,
    });
    guardMocks.requireSuperAdmin.mockRejectedValueOnce(accessError);

    await expect(action({ status: "idle" }, data)).resolves.toEqual({
      message: "只有超级管理员可以管理极风连接。",
      status: "error",
    });

    expect(guardMocks.requireSuperAdmin).toHaveBeenCalledTimes(1);
    expect(Object.values(serviceMocks).every((service) => service.mock.calls.length === 0)).toBe(
      true,
    );
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a stable safe state for an unauthenticated request", async () => {
    const unauthenticated = Object.assign(new Error("UNAUTHENTICATED"), {
      code: "UNAUTHENTICATED",
      status: 401,
    });
    guardMocks.requireSuperAdmin.mockRejectedValueOnce(unauthenticated);

    await expect(
      runJifengDiagnosticAction({ status: "idle" }, form()),
    ).resolves.toEqual({
      message: "登录状态已失效，请重新登录。",
      status: "error",
    });
    expect(serviceMocks.runStoredJifengDiagnostic).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid email", "not-an-email", "one-time-token-1234", "email"],
    ["15-character token", "owner@example.test", "123456789012345", "oneTimeToken"],
    ["513-character token", "owner@example.test", "x".repeat(513), "oneTimeToken"],
  ])("rejects authorization with an %s", async (_name, email, oneTimeToken, field) => {
    const result = await authorizeJifengConnectionAction(
      { status: "idle" },
      form({ email, oneTimeToken }),
    );

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.[field]).toBeDefined();
    expect(serviceMocks.authorizeJifengConnection).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("normalizes authorization input without returning the one-time token", async () => {
    const oneTimeToken = "  one-time-token-1234  ";

    const result = await authorizeJifengConnectionAction(
      { status: "idle" },
      form({ email: "  OWNER@Example.Test ", oneTimeToken }),
    );

    expect(serviceMocks.authorizeJifengConnection).toHaveBeenCalledWith({
      actor,
      email: "owner@example.test",
      oneTimeToken: "one-time-token-1234",
    });
    expect(result).toEqual({ message: "极风授权已完成。", status: "success" });
    expect(JSON.stringify(result)).not.toContain("one-time-token-1234");
    expect(cacheMocks.revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/admin/system/integrations",
    );
  });

  it.each([
    ["enable", setJifengFulfillmentAction, { enabled: "true", reason: "一" }],
    ["disable", setJifengFulfillmentAction, { enabled: "false", reason: "一" }],
    ["disconnect", disconnectJifengConnectionAction, { reason: "一" }],
    ["enable long", setJifengFulfillmentAction, { enabled: "true", reason: "原".repeat(501) }],
    ["disconnect long", disconnectJifengConnectionAction, { reason: "原".repeat(501) }],
  ])("requires a trimmed 2-500 character reason for %s", async (_name, action, entries) => {
    const result = await action({ status: "idle" }, form(entries));

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.reason).toBeDefined();
    expect(serviceMocks.setJifengFulfillmentEnabled).not.toHaveBeenCalled();
    expect(serviceMocks.disconnectJifengConnection).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ logisticsId: "0", warehouseCode: "CA-1" }, "logisticsId"],
    [
      { logisticsId: "9007199254740992", warehouseCode: "CA-1" },
      "logisticsId",
    ],
    [{ logisticsId: "7", warehouseCode: " " }, "warehouseCode"],
    [{ logisticsId: "7", warehouseCode: "x".repeat(129) }, "warehouseCode"],
  ])("rejects an invalid bounded resource identifier", async (entries, field) => {
    const result = await selectJifengResourcesAction(
      { status: "idle" },
      form(entries),
    );

    expect(result.status).toBe("error");
    expect(result.fieldErrors?.[field]).toBeDefined();
    expect(serviceMocks.discoverJifengResources).not.toHaveBeenCalled();
    expect(serviceMocks.selectJifengResources).not.toHaveBeenCalled();
  });

  it("re-discovers and matches explicit resource identifiers before selection", async () => {
    const result = await selectJifengResourcesAction(
      { status: "idle" },
      form({ logisticsId: "7", warehouseCode: " CA-1 " }),
    );

    expect(serviceMocks.discoverJifengResources).toHaveBeenCalledWith({ actor });
    expect(serviceMocks.selectJifengResources).toHaveBeenCalledWith({
      actor,
      logistics: { code: "CA_POST", id: 7, name: "加拿大邮政" },
      warehouse: { code: "CA-1", country: "CA", name: "加拿大一号仓" },
    });
    expect(result).toEqual({ message: "仓库与物流渠道已确认。", status: "success" });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/admin/system/integrations",
    );
  });

  it("returns refreshed safe candidates when resource discovery is ambiguous", async () => {
    const result = await discoverJifengResourcesAction({ status: "idle" }, form());

    expect(result).toMatchObject({
      message: "资源已更新，请明确选择仓库和物流渠道。",
      resources: {
        logistics: [{ id: 7, name: "加拿大邮政" }],
        warehouses: [{ code: "CA-1", name: "加拿大一号仓" }],
      },
      status: "success",
    });
    expect(JSON.stringify(result)).not.toMatch(/token|secret|authorization.?code/i);
    expect(cacheMocks.revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/admin/system/integrations",
    );
  });

  it("accepts a production logistics identifier larger than a 32-bit integer", async () => {
    const productionId = 7_451_320_609;
    serviceMocks.discoverJifengResources.mockResolvedValueOnce({
      logistics: [
        { code: "ship-233", id: productionId, name: "ship-233" },
      ],
      warehouses: [
        { code: "Ottawa", country: "CA", name: "Ottawa Warehouse" },
      ],
    });

    const result = await selectJifengResourcesAction(
      { status: "idle" },
      form({
        logisticsId: String(productionId),
        warehouseCode: "Ottawa",
      }),
    );

    expect(result.status).toBe("success");
    expect(serviceMocks.selectJifengResources).toHaveBeenCalledWith({
      actor,
      logistics: { code: "ship-233", id: productionId, name: "ship-233" },
      warehouse: {
        code: "Ottawa",
        country: "CA",
        name: "Ottawa Warehouse",
      },
    });
  });

  it.each(["INVALID_RESPONSE", "NETWORK_ERROR", "TIMEOUT"])(
    "keeps a %s resource-discovery failure inside the action UI",
    async (code) => {
      serviceMocks.discoverJifengResources.mockRejectedValueOnce({ code });

      const result = await discoverJifengResourcesAction(
        { status: "idle" },
        form(),
      );

      expect(result).toEqual({
        message: "极风资源读取失败，请稍后重新发现；现有授权不会丢失。",
        status: "error",
      });
      expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("rejects a resource identifier that no longer appears in discovery", async () => {
    const result = await selectJifengResourcesAction(
      { status: "idle" },
      form({ logisticsId: "99", warehouseCode: "CA-1" }),
    );

    expect(result).toEqual({
      message: "所选资源已变化，请重新发现并再次选择。",
      status: "error",
    });
    expect(serviceMocks.selectJifengResources).not.toHaveBeenCalled();
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes trimmed reasons and revalidates only the integrations page after mutations", async () => {
    const enabled = await setJifengFulfillmentAction(
      { status: "idle" },
      form({ enabled: "true", reason: "  已确认自动推单后果  " }),
    );
    const disabled = await setJifengFulfillmentAction(
      { status: "idle" },
      form({ enabled: "false", reason: "  暂停生产履约  " }),
    );
    const disconnected = await disconnectJifengConnectionAction(
      { status: "idle" },
      form({ reason: "  轮换授权负责人  " }),
    );

    expect(serviceMocks.setJifengFulfillmentEnabled).toHaveBeenNthCalledWith(1, {
      actor,
      enabled: true,
      reason: "已确认自动推单后果",
    });
    expect(serviceMocks.setJifengFulfillmentEnabled).toHaveBeenNthCalledWith(2, {
      actor,
      enabled: false,
      reason: "暂停生产履约",
    });
    expect(serviceMocks.disconnectJifengConnection).toHaveBeenCalledWith({
      actor,
      reason: "轮换授权负责人",
    });
    expect(enabled).toEqual({ message: "极风自动履约已启用。", status: "success" });
    expect(disabled).toEqual({ message: "极风自动履约已停用。", status: "success" });
    expect(disconnected).toEqual({ message: "极风连接已安全断开。", status: "success" });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledTimes(3);
    expect(cacheMocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/system/integrations",
    );
  });

  it("revalidates a stored failed diagnostic but returns only safe recovery copy", async () => {
    serviceMocks.runStoredJifengDiagnostic.mockResolvedValueOnce({
      code: "PROVIDER_ERROR",
      ok: false,
      ranAt: new Date("2026-08-13T08:00:00.000Z"),
    });

    const result = await runJifengDiagnosticAction({ status: "idle" }, form());

    expect(result).toEqual({
      message: "只读诊断未通过，请检查授权状态后重试。",
      status: "error",
    });
    expect(cacheMocks.revalidatePath).toHaveBeenCalledExactlyOnceWith(
      "/admin/system/integrations",
    );
  });

  it("maps only an allowlisted business code without exposing its message", async () => {
    const thirdPartyMessage = "provider says token=secret-value";
    serviceMocks.authorizeJifengConnection.mockRejectedValueOnce(
      Object.assign(new Error(thirdPartyMessage), {
        code: "AUTHORIZATION_FAILED",
      }),
    );

    const result = await authorizeJifengConnectionAction(
      { status: "idle" },
      validAuthorization(),
    );

    expect(result).toEqual({
      message: "授权未完成，请获取新的一次性令牌后重试。",
      status: "error",
    });
    expect(JSON.stringify(result)).not.toContain(thirdPartyMessage);
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows unknown errors instead of reflecting them to the client", async () => {
    const unknown = Object.assign(new Error("token=unknown-secret"), {
      code: "UNRECOGNIZED_PROVIDER_FAILURE",
    });
    serviceMocks.disconnectJifengConnection.mockRejectedValueOnce(unknown);

    await expect(
      disconnectJifengConnectionAction(
        { status: "idle" },
        form({ reason: "轮换授权负责人" }),
      ),
    ).rejects.toBe(unknown);
    expect(cacheMocks.revalidatePath).not.toHaveBeenCalled();
  });
});
