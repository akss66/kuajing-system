import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { db } from "@/db/client";
import { adminUsers, jifengConnections } from "@/db/schema";
import { JifengClient } from "@/integrations/jifeng/client";
import { encryptJifengSecret } from "@/modules/jifeng-connection/crypto";
import {
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

  test("allows stored credentials for read-only reconciliation while fulfillment is disabled", async () => {
    await insertConnection("READY_DISABLED");

    const runtime = await getJifengReadClient();

    expect(runtime.client).toBeInstanceOf(JifengClient);
    expect(runtime.config).toEqual({
      logisticsId: 73,
      warehouseCode: "DB-WAREHOUSE",
    });
  });

  test("allows legacy static credentials for reads only when the database row is absent", async () => {
    const runtime = await getJifengReadClient();

    expect(runtime.client).toBeInstanceOf(JifengClient);
    expect(runtime.config).toEqual({
      logisticsId: 91,
      warehouseCode: "LEGACY-WAREHOUSE",
    });
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
