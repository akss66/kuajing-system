import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import { adminUsers, auditLogs, jifengConnections } from "@/db/schema";
import { JifengClient } from "@/integrations/jifeng/client";
import { encryptJifengSecret } from "@/modules/jifeng-connection/crypto";
import {
  getEnabledJifengCancellationClient,
  getEnabledJifengLookupClient,
  getEnabledJifengWriteClient,
  getJifengReadClient,
} from "@/modules/jifeng-connection/provider";
import type { JifengConnectionStatus } from "@/modules/jifeng-connection/types";

const encryptionKey = Buffer.alloc(32, 29);
const now = new Date("2026-08-13T08:00:00.000Z");

async function resetConnection() {
  await db.execute(sql.raw(`
    truncate table
      jifeng_authorization_attempts,
      jifeng_connections,
      audit_logs,
      admin_users
    restart identity cascade
  `));
}

async function insertConnection(
  status: JifengConnectionStatus,
  options: {
    accessTokenExpiresAt?: Date;
    logisticsId?: number | null;
    warehouseCode?: string | null;
  } = {},
) {
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: `Provider ${status}`,
      loginIdentifier: `provider-${status.toLowerCase()}@example.test`,
    })
    .returning();
  const enabled = status === "ENABLED";

  await db.insert(jifengConnections).values({
    accessTokenEncrypted: encryptJifengSecret("database-access-token", encryptionKey),
    accessTokenExpiresAt:
      options.accessTokenExpiresAt ?? new Date("2099-01-01T00:00:00.000Z"),
    authorizedAt: now,
    authorizedByAdminUserId: admin.id,
    connectionKey: "PRIMARY",
    fulfillmentEnabledAt: enabled ? now : null,
    fulfillmentEnabledByAdminUserId: enabled ? admin.id : null,
    logisticsId:
      options.logisticsId === undefined ? 73 : options.logisticsId,
    refreshTokenEncrypted: encryptJifengSecret(
      "database-refresh-token",
      encryptionKey,
    ),
    refreshTokenExpiresAt: new Date("2099-01-02T00:00:00.000Z"),
    status,
    updatedAt: now,
    userId: "database-user",
    warehouseCode:
      options.warehouseCode === undefined ? "DB-WAREHOUSE" : options.warehouseCode,
  });
}

describe("Jifeng runtime credential provider", () => {
  beforeEach(async () => {
    await resetConnection();
    vi.stubEnv("JIFENG_ACCESS_TOKEN", "legacy-access-token");
    vi.stubEnv("JIFENG_BASE_URL", "https://jifeng.example.test");
    vi.stubEnv("JIFENG_CLIENT_ID", "client-id");
    vi.stubEnv("JIFENG_CLIENT_SECRET", "client-secret");
    vi.stubEnv("JIFENG_LEGACY_FULFILLMENT_ENABLED", "true");
    vi.stubEnv("JIFENG_LOGISTICS_ID", "91");
    vi.stubEnv("JIFENG_REFRESH_TOKEN", "legacy-refresh-token");
    vi.stubEnv("JIFENG_TOKEN_ENCRYPTION_KEY", encryptionKey.toString("base64url"));
    vi.stubEnv("JIFENG_USER_ID", "legacy-user");
    vi.stubEnv("JIFENG_WAREHOUSE_CODE", "LEGACY-WAREHOUSE");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await resetConnection();
  });

  test.each([
    "DISCONNECTED",
    "AUTHORIZED",
    "RESOURCE_SELECTION_REQUIRED",
    "READY_DISABLED",
    "REFRESH_REQUIRED",
    "ERROR",
  ] as const)("denies a write client while the database status is %s", async (status) => {
    await insertConnection(status);

    await expect(getEnabledJifengWriteClient()).rejects.toMatchObject({
      code: "FULFILLMENT_DISABLED",
    });
  });

  test("uses valid enabled database credentials and resources before legacy environment values", async () => {
    await insertConnection("ENABLED");
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        code: 0,
        data: { erpNo: "PROVIDER-PRECEDENCE", status: 6 },
        message: "SUCCESS",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getEnabledJifengWriteClient();
    await runtime.client.getOrder({ erpNo: "PROVIDER-PRECEDENCE" });

    expect(runtime.client).toBeInstanceOf(JifengClient);
    expect(runtime.config).toEqual({
      logisticsId: 73,
      warehouseCode: "DB-WAREHOUSE",
    });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("accessToken")).toBe("database-access-token");
    expect(headers.get("userId")).toBe("database-user");
    expect(headers.get("accessToken")).not.toBe("legacy-access-token");
  });

  test.each([
    { logisticsId: null, warehouseCode: "DB-WAREHOUSE" },
    { logisticsId: 73, warehouseCode: null },
  ])("denies enabled database credentials with invalid resources %#", async (resources) => {
    await insertConnection("ENABLED", resources);

    await expect(getEnabledJifengWriteClient()).rejects.toMatchObject({
      code: "RUNTIME_CONFIG_INVALID",
    });
  });

  test("refreshes an expired stored access token before returning the write client", async () => {
    await insertConnection("ENABLED", { accessTokenExpiresAt: new Date(0) });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, request?: RequestInit) => {
      if (new URL(String(url)).pathname === "/api/oauth/refreshToken") {
        return Response.json({
          code: 0,
          data: {
            accessToken: "refreshed-database-access",
            expireIn: 86_400,
            refreshExpireIn: 31_536_000,
            refreshToken: "refreshed-database-refresh",
            userId: "refreshed-database-user",
          },
          message: "SUCCESS",
        });
      }
      const erpNo = String(JSON.parse(String(request?.body)).erpNo);
      return Response.json({
        code: 0,
        data: { erpNo, status: 6 },
        message: "SUCCESS",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getEnabledJifengWriteClient();
    await runtime.client.getOrder({ erpNo: "PROVIDER-REFRESH" });

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/oauth/refreshToken",
      "/api/order/get",
    ]);
    const businessHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(businessHeaders.get("accessToken")).toBe("refreshed-database-access");
    expect(businessHeaders.get("userId")).toBe("refreshed-database-user");
  });

  test("persists a managed cancellation authentication rejection and never refreshes or replays", async () => {
    await insertConnection("ENABLED");
    const [before] = await db.select().from(jifengConnections);
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      void url;
      return Response.json({
        code: 10002,
        data: null,
        message: "access token rejected",
        requestId: "managed-write-rejection",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getEnabledJifengCancellationClient();
    await expect(
      runtime.client.cancelOrder({
        deleteRecord: false,
        erpNo: "PROVIDER-MANAGED-AUTH",
      }),
    ).rejects.toMatchObject({
      code: "REFRESH_REQUIRED",
      requestId: "managed-write-rejection",
      retryable: false,
    });

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/order/cancel",
    ]);
    const [after] = await db.select().from(jifengConnections);
    expect(after).toMatchObject({
      accessTokenEncrypted: before.accessTokenEncrypted,
      fulfillmentEnabledAt: before.fulfillmentEnabledAt,
      fulfillmentEnabledByAdminUserId: before.fulfillmentEnabledByAdminUserId,
      lastErrorCode: "ACCESS_TOKEN_REJECTED",
      refreshTokenEncrypted: before.refreshTokenEncrypted,
      status: "REFRESH_REQUIRED",
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_RUNTIME_AUTH_REJECTED"));
    expect(audit).toMatchObject({
      actorId: null,
      actorType: "SYSTEM",
      afterJson: {
        errorCategory: "ACCESS_TOKEN_REJECTED",
        status: "REFRESH_REQUIRED",
      },
      beforeJson: { status: "ENABLED" },
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /database-access-token|database-refresh-token|client-secret/i,
    );
    await expect(getEnabledJifengWriteClient()).rejects.toMatchObject({
      code: "FULFILLMENT_DISABLED",
    });
  });

  test("allows enabled existing-order lookup without warehouse or logistics configuration", async () => {
    await insertConnection("ENABLED", {
      logisticsId: null,
      warehouseCode: null,
    });
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        code: 0,
        data: {
          erpNo: "REMOTE-ERP-LOOKUP",
          orderNo: "JF-ORDER-LOOKUP",
          platformOrderNo: "TEMU-ORDER-LOOKUP",
          status: 2,
        },
        message: "SUCCESS",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getEnabledJifengLookupClient();
    await expect(
      runtime.client.getOrder({ platformOrderNo: "TEMU-ORDER-LOOKUP" }),
    ).resolves.toMatchObject({
      erpNo: "REMOTE-ERP-LOOKUP",
      platformOrderNo: "TEMU-ORDER-LOOKUP",
    });
    expect(runtime).not.toHaveProperty("config");
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
      "/api/order/get",
    );
  });

  test("allows stored credentials for read-only reconciliation while fulfillment is disabled", async () => {
    await insertConnection("READY_DISABLED");

    const runtime = await getJifengReadClient();

    expect(runtime.client).toBeInstanceOf(JifengClient);
    expect(runtime).not.toHaveProperty("config");
  });

  test("routes a stored read authentication rejection through persisted state", async () => {
    await insertConnection("READY_DISABLED");
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      void url;
      return Response.json({
        code: 10015,
        data: null,
        requestId: "managed-read-rejection",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getJifengReadClient();
    await expect(
      runtime.client.getOrder({ erpNo: "PROVIDER-MANAGED-READ" }),
    ).rejects.toMatchObject({ code: "REFRESH_REQUIRED", retryable: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
      "/api/order/get",
    );
    const [stored] = await db.select().from(jifengConnections);
    expect(stored.status).toBe("REFRESH_REQUIRED");
  });

  test.each(["AUTHORIZED", "RESOURCE_SELECTION_REQUIRED"] as const)(
    "allows stored %s credentials to query without selected fulfillment resources",
    async (status) => {
      await insertConnection(status, {
        logisticsId: null,
        warehouseCode: null,
      });
      const fetchMock = vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >(async () =>
        Response.json({
          code: 0,
          data: { erpNo: `READ-${status}`, status: 6 },
          message: "SUCCESS",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const runtime = await getJifengReadClient();
      await runtime.client.getOrder({ erpNo: `READ-${status}` });

      expect(runtime).not.toHaveProperty("config");
      expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
        "/api/order/get",
      );
      await expect(getEnabledJifengWriteClient()).rejects.toMatchObject({
        code: "FULFILLMENT_DISABLED",
      });
    },
  );

  test("allows legacy authorized-only credentials to read when the database row is absent", async () => {
    vi.stubEnv("JIFENG_LOGISTICS_ID", "");
    vi.stubEnv("JIFENG_WAREHOUSE_CODE", "");
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        code: 0,
        data: { erpNo: "LEGACY-AUTHORIZED-READ", status: 6 },
        message: "SUCCESS",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getJifengReadClient();
    await runtime.client.getOrder({ erpNo: "LEGACY-AUTHORIZED-READ" });

    expect(runtime.client).toBeInstanceOf(JifengClient);
    expect(runtime).not.toHaveProperty("config");
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe(
      "/api/order/get",
    );
    await expect(getEnabledJifengWriteClient()).rejects.toMatchObject({
      name: "JifengConfigError",
    });
  });

  test("keeps absent-row legacy internal refresh compatibility without mutating the database", async () => {
    vi.stubEnv("JIFENG_LOGISTICS_ID", "");
    vi.stubEnv("JIFENG_WAREHOUSE_CODE", "");
    let businessCalls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/oauth/refreshToken") {
        return Response.json({
          code: 0,
          data: {
            accessToken: "legacy-refreshed-access",
            expireIn: 86_400,
            refreshExpireIn: 31_536_000,
            refreshToken: "legacy-refreshed-refresh",
            userId: "legacy-refreshed-user",
          },
        });
      }
      businessCalls += 1;
      return businessCalls === 1
        ? Response.json({ code: 10002, data: null })
        : Response.json({
            code: 0,
            data: { erpNo: "LEGACY-REFRESH", status: 6 },
          });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = await getJifengReadClient();
    await expect(
      runtime.client.getOrder({ erpNo: "LEGACY-REFRESH" }),
    ).resolves.toMatchObject({ erpNo: "LEGACY-REFRESH", status: 6 });

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/order/get",
      "/api/oauth/refreshToken",
      "/api/order/get",
    ]);
    expect(await db.select().from(jifengConnections)).toEqual([]);
  });

  test("denies absent-row legacy writes unless compatibility is exactly true", async () => {
    vi.stubEnv("JIFENG_LEGACY_FULFILLMENT_ENABLED", "TRUE");
    await expect(getEnabledJifengWriteClient()).rejects.toMatchObject({
      code: "LEGACY_FULFILLMENT_DISABLED",
    });

    vi.stubEnv("JIFENG_LEGACY_FULFILLMENT_ENABLED", "true");
    const runtime = await getEnabledJifengWriteClient();
    expect(runtime.config).toEqual({
      logisticsId: 91,
      warehouseCode: "LEGACY-WAREHOUSE",
    });
  });
});
