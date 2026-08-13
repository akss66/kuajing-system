import { createServer } from "node:http";

import { and, eq, gte, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  adminUsers,
  auditLogs,
  jifengAuthorizationAttempts,
  jifengConnections,
} from "@/db/schema";
import type {
  JifengOfflineLogistics,
  JifengTokenSet,
  JifengWarehouse,
} from "@/integrations/jifeng/types";
import { decryptJifengSecret } from "@/modules/jifeng-connection/crypto";
import {
  JifengConnectionError,
  authorizeJifengConnection,
  discoverJifengResources,
  disconnectJifengConnection,
  refreshJifengConnection,
  runStoredJifengDiagnostic,
  selectJifengResources,
  setJifengFulfillmentEnabled,
  type JifengAuthorizationPort,
} from "@/modules/jifeng-connection/service";
import {
  getJifengConnectionAdminView,
  getJifengConnectionPublicStatus,
} from "@/modules/jifeng-connection/queries";
import type { SuperAdminPrincipal } from "@/modules/identity/principal";

const encryptionKey = Buffer.alloc(32, 73);
const keyText = encryptionKey.toString("base64url");
const startedAt = new Date("2026-08-13T03:00:00.000Z");
const actor = (userId: string): SuperAdminPrincipal => ({
  kind: "SUPER_ADMIN",
  userId,
});

async function createAdmin(label: string) {
  const [admin] = await db
    .insert(adminUsers)
    .values({
      displayName: `Jifeng service ${label}`,
      loginIdentifier: `jifeng-service-${label}-${crypto.randomUUID()}@example.test`,
    })
    .returning({ id: adminUsers.id });
  return admin;
}

function tokenSet(suffix = "one"): JifengTokenSet {
  return {
    accessToken: `access-${suffix}`,
    expireIn: 3_600,
    refreshExpireIn: 86_400,
    refreshToken: `refresh-${suffix}`,
    userId: `user-${suffix}`,
  };
}

const warehouse = (code: string): JifengWarehouse => ({
  code,
  country: "CA",
  name: `Warehouse ${code}`,
});
const logistics = (id: number): JifengOfflineLogistics => ({
  code: `CP-${id}`,
  id,
  name: "Canada Post",
});

function authorizationPort(input?: {
  discovery?: {
    logistics: JifengOfflineLogistics[];
    warehouses: JifengWarehouse[];
  };
  exchangeError?: Error;
  tokens?: JifengTokenSet;
}) {
  const calls: string[] = [];
  const port: JifengAuthorizationPort = {
    async authorize() {
      calls.push("authorize");
      return { authorizationCode: "authorization-code-secret" };
    },
    async discoverResources() {
      calls.push("discover");
      return (
        input?.discovery ?? {
          logistics: [logistics(7)],
          warehouses: [warehouse("CA-1")],
        }
      );
    },
    async exchangeAuthorizationCode() {
      calls.push("exchange");
      if (input?.exchangeError) throw input.exchangeError;
      return input?.tokens ?? tokenSet();
    },
  };
  return { calls, port };
}

async function authorizeFixture(
  adminId: string,
  input?: Parameters<typeof authorizationPort>[0],
) {
  const fake = authorizationPort(input);
  const view = await authorizeJifengConnection({
    actor: actor(adminId),
    email: "owner@example.test",
    now: startedAt,
    oneTimeToken: "one-time-token-secret",
    port: fake.port,
  });
  return { ...fake, view };
}

describe("Jifeng connection lifecycle", () => {
  beforeEach(() => {
    process.env.JIFENG_BASE_URL = "https://jifeng.example.test";
    process.env.JIFENG_CLIENT_ID = "client-id";
    process.env.JIFENG_CLIENT_SECRET = "client-secret-never-persist";
    process.env.JIFENG_TOKEN_ENCRYPTION_KEY = keyText;
  });

  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        jifeng_authorization_attempts,
        jifeng_connections,
        audit_logs,
        admin_users
      restart identity cascade
    `));
  });

  test("rejects every mutation when the runtime actor is not SUPER_ADMIN", async () => {
    const admin = await createAdmin("role");
    const invalidActor = { kind: "ADMIN", userId: admin.id } as never;

    await expect(
      authorizeJifengConnection({
        actor: invalidActor,
        email: "owner@example.test",
        oneTimeToken: "must-not-escape",
        port: authorizationPort().port,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      selectJifengResources({
        actor: invalidActor,
        logistics: logistics(7),
        warehouse: warehouse("CA-1"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(jifengAuthorizationAttempts)).toEqual([]);
  });

  test("encrypts OAuth tokens and auto-selects exactly one warehouse and Canada Post candidate", async () => {
    const admin = await createAdmin("authorize");
    const { calls, view } = await authorizeFixture(admin.id);

    expect(calls).toEqual(["authorize", "exchange", "discover"]);
    expect(view).toMatchObject({
      fulfillmentEnabled: false,
      logistics: { id: 7, name: "Canada Post" },
      status: "READY_DISABLED",
      warehouse: { code: "CA-1", name: "Warehouse CA-1" },
    });
    expect(JSON.stringify(view)).not.toMatch(
      /owner@example|one-time-token|authorization-code|access-one|refresh-one/i,
    );

    const [stored] = await db.select().from(jifengConnections);
    expect(stored.accessTokenEncrypted).not.toBeNull();
    expect(stored.refreshTokenEncrypted).not.toBeNull();
    expect(
      decryptJifengSecret(stored.accessTokenEncrypted!, encryptionKey),
    ).toBe("access-one");
    expect(
      decryptJifengSecret(stored.refreshTokenEncrypted!, encryptionKey),
    ).toBe("refresh-one");

    const databaseDump = JSON.stringify({
      attempts: await db.select().from(jifengAuthorizationAttempts),
      audits: await db.select().from(auditLogs),
    });
    expect(databaseDump).not.toMatch(
      /owner@example|one-time-token|authorization-code|access-one|refresh-one/i,
    );
  });

  test("requires explicit resource selection when discovery is ambiguous", async () => {
    const admin = await createAdmin("ambiguous");
    const { view } = await authorizeFixture(admin.id, {
      discovery: {
        logistics: [logistics(7), logistics(8)],
        warehouses: [warehouse("CA-1"), warehouse("CA-2")],
      },
    });

    expect(view).toMatchObject({
      logistics: null,
      status: "RESOURCE_SELECTION_REQUIRED",
      warehouse: null,
    });
  });

  test("does not let resource selection manufacture authorization for a disconnected row", async () => {
    const admin = await createAdmin("selection-disconnected");
    await db.insert(jifengConnections).values({ connectionKey: "PRIMARY" });

    await expect(
      selectJifengResources({
        actor: actor(admin.id),
        logistics: logistics(7),
        warehouse: warehouse("CA-1"),
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    expect(await getJifengConnectionPublicStatus()).toMatchObject({
      connected: false,
      status: "DISCONNECTED",
    });
  });

  test("keeps the old encrypted connection unchanged when reauthorization fails", async () => {
    const admin = await createAdmin("reauthorize");
    await authorizeFixture(admin.id);
    const [before] = await db.select().from(jifengConnections);
    const failure = new Error(
      "provider leaked owner@example.test one-time-token-secret access-two",
    );

    await expect(
      authorizeFixture(admin.id, { exchangeError: failure }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });

    const [after] = await db.select().from(jifengConnections);
    expect(after).toMatchObject({
      accessTokenEncrypted: before.accessTokenEncrypted,
      refreshTokenEncrypted: before.refreshTokenEncrypted,
      status: before.status,
      userId: before.userId,
      warehouseCode: before.warehouseCode,
    });
    const persisted = JSON.stringify({
      attempts: await db.select().from(jifengAuthorizationAttempts),
      audits: await db.select().from(auditLogs),
    });
    expect(persisted).not.toMatch(
      /owner@example|one-time-token|authorization-code|access-two/i,
    );
  });

  test("records a redacted failed attempt when server configuration is unavailable", async () => {
    const admin = await createAdmin("configuration-failure");
    delete process.env.JIFENG_CLIENT_SECRET;

    await expect(
      authorizeJifengConnection({
        actor: actor(admin.id),
        email: "config-owner@example.test",
        oneTimeToken: "config-token-secret",
        port: authorizationPort().port,
      }),
    ).rejects.toMatchObject({ code: "DEVELOPER_CONFIG_INVALID" });

    const [attempt] = await db.select().from(jifengAuthorizationAttempts);
    expect(attempt).toMatchObject({
      errorCategory: "DEVELOPER_CONFIG_INVALID",
      result: "FAILED",
    });
    const dump = JSON.stringify(await db.select().from(auditLogs));
    expect(dump).not.toMatch(/config-owner|config-token-secret/i);
    expect(dump).toMatch(/JIFENG_OAUTH_FAILED/);
  });

  test("concurrently limits one actor to five counted authorization attempts per rolling ten minutes", async () => {
    const admin = await createAdmin("limit");
    let releaseRemote!: () => void;
    const remoteGate = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    const port = authorizationPort().port;
    port.authorize = async () => {
      await remoteGate;
      throw new Error("safe provider failure");
    };

    const attempts = Array.from({ length: 6 }, () =>
      authorizeJifengConnection({
        actor: actor(admin.id),
        email: "limit@example.test",
        now: startedAt,
        oneTimeToken: "rate-limit-secret",
        port,
      }),
    );
    const settledPromise = Promise.allSettled(attempts);
    await expect.poll(async () =>
      db
        .select({ id: jifengAuthorizationAttempts.id })
        .from(jifengAuthorizationAttempts)
        .where(
          and(
            eq(jifengAuthorizationAttempts.adminUserId, admin.id),
            gte(
              jifengAuthorizationAttempts.attemptedAt,
              new Date(startedAt.getTime() - 10 * 60_000),
            ),
          ),
        ),
    ).toHaveLength(5);
    releaseRemote();

    const settled = await settledPromise;
    expect(
      settled.filter(
        (item) =>
          item.status === "rejected" &&
          item.reason instanceof JifengConnectionError &&
          item.reason.code === "AUTHORIZATION_RATE_LIMITED",
      ),
    ).toHaveLength(1);
    expect(await db.select().from(jifengAuthorizationAttempts)).toHaveLength(5);
  });

  test("requires a diagnostic newer than resource changes before enablement", async () => {
    const admin = await createAdmin("enable");
    await authorizeFixture(admin.id);
    const reason = "business owner explicitly approved production fulfillment";

    await expect(
      setJifengFulfillmentEnabled({
        actor: actor(admin.id),
        enabled: true,
        now: new Date(startedAt.getTime() + 1_000),
        reason,
      }),
    ).rejects.toMatchObject({ code: "DIAGNOSTIC_REQUIRED" });

    await runStoredJifengDiagnostic({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 2_000),
      port: { async run() { return { ok: true as const }; } },
    });
    await setJifengFulfillmentEnabled({
      actor: actor(admin.id),
      enabled: true,
      now: new Date(startedAt.getTime() + 3_000),
      reason,
    });
    expect(await getJifengConnectionAdminView()).toMatchObject({
      fulfillmentEnabled: true,
      status: "ENABLED",
    });

    await selectJifengResources({
      actor: actor(admin.id),
      logistics: logistics(9),
      now: new Date(startedAt.getTime() + 4_000),
      warehouse: warehouse("CA-2"),
    });
    await expect(
      setJifengFulfillmentEnabled({
        actor: actor(admin.id),
        enabled: true,
        now: new Date(startedAt.getTime() + 5_000),
        reason,
      }),
    ).rejects.toMatchObject({ code: "DIAGNOSTIC_REQUIRED" });
  });

  test("does not store a stale diagnostic when resources change during the remote probe", async () => {
    const admin = await createAdmin("diagnostic-race");
    await authorizeFixture(admin.id);
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const diagnostic = runStoredJifengDiagnostic({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 1_000),
      port: {
        async run() {
          probeStarted();
          await gate;
          return { ok: true as const };
        },
      },
    });
    await started;
    await selectJifengResources({
      actor: actor(admin.id),
      logistics: logistics(9),
      now: new Date(startedAt.getTime() + 2_000),
      warehouse: warehouse("CA-2"),
    });
    releaseProbe();

    await expect(diagnostic).rejects.toMatchObject({ code: "DIAGNOSTIC_STALE" });
    expect(await getJifengConnectionAdminView()).toMatchObject({
      lastDiagnosticAt: null,
      logistics: { id: 9 },
      warehouse: { code: "CA-2" },
    });
  });

  test("does not let an in-flight diagnostic mask a concurrent refresh failure", async () => {
    const admin = await createAdmin("diagnostic-refresh-race");
    await authorizeFixture(admin.id, {
      tokens: { ...tokenSet("old"), expireIn: 120 },
    });
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const diagnostic = runStoredJifengDiagnostic({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 1_000),
      port: {
        async run() {
          probeStarted();
          await gate;
          return { ok: true as const };
        },
      },
    });
    await started;
    await expect(
      refreshJifengConnection({
        now: new Date(startedAt.getTime() + 121_000),
        port: { async refresh() { throw new Error("safe refresh failure"); } },
      }),
    ).rejects.toMatchObject({ code: "REFRESH_FAILED" });
    releaseProbe();

    await expect(diagnostic).rejects.toMatchObject({ code: "DIAGNOSTIC_STALE" });
    expect(await getJifengConnectionAdminView()).toMatchObject({
      lastDiagnosticAt: null,
      lastError: { code: "PROVIDER_ERROR" },
      status: "REFRESH_REQUIRED",
    });
  });

  test("does not reapply discovery after a concurrent disconnect", async () => {
    const admin = await createAdmin("discovery-disconnect-race");
    await authorizeFixture(admin.id);
    let releaseDiscovery!: () => void;
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discovery = discoverJifengResources({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 1_000),
      port: {
        async discoverResources() {
          discoveryStarted();
          await gate;
          return { logistics: [logistics(9)], warehouses: [warehouse("CA-2")] };
        },
      },
    });
    await started;
    await disconnectJifengConnection({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 2_000),
      reason: "disconnect while discovery is in flight",
    });
    releaseDiscovery();

    await expect(discovery).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    expect(await getJifengConnectionPublicStatus()).toMatchObject({
      connected: false,
      status: "DISCONNECTED",
    });
  });

  test("uses the stored credentials for the default read-only order diagnostic", async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 50017, message: "not found" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      process.env.JIFENG_BASE_URL = `http://127.0.0.1:${address.port}`;
      const admin = await createAdmin("default-diagnostic");
      await authorizeFixture(admin.id);

      const result = await runStoredJifengDiagnostic({
        actor: actor(admin.id),
        now: new Date(startedAt.getTime() + 1_000),
      });

      expect(result.ok).toBe(true);
      expect(paths).toEqual(["/api/order/get"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("disconnect requires a reason, disables first, clears credentials and keeps audits redacted", async () => {
    const admin = await createAdmin("disconnect");
    await authorizeFixture(admin.id);
    await runStoredJifengDiagnostic({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 1_000),
      port: { async run() { return { ok: true as const }; } },
    });
    await setJifengFulfillmentEnabled({
      actor: actor(admin.id),
      enabled: true,
      now: new Date(startedAt.getTime() + 2_000),
      reason: "approved before disconnect fixture",
    });

    await expect(
      disconnectJifengConnection({ actor: actor(admin.id), reason: " " }),
    ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await disconnectJifengConnection({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 3_000),
      reason: "rotating ownership safely; credential access-one",
    });

    const [stored] = await db.select().from(jifengConnections);
    expect(stored).toMatchObject({
      accessTokenEncrypted: null,
      logisticsId: null,
      refreshTokenEncrypted: null,
      status: "DISCONNECTED",
      userId: null,
      warehouseCode: null,
    });
    const actions = (await db.select().from(auditLogs)).map(
      ({ action }) => action,
    );
    expect(actions.slice(-2)).toEqual([
      "JIFENG_FULFILLMENT_DISABLED",
      "JIFENG_DISCONNECTED",
    ]);
    expect(JSON.stringify(await db.select().from(auditLogs))).not.toMatch(
      /access-one/,
    );
  });

  test("uses a fixed safe audit reason when disconnect cannot decrypt stored credentials", async () => {
    const admin = await createAdmin("disconnect-corrupted-key");
    await authorizeFixture(admin.id);
    process.env.JIFENG_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 74).toString("base64url");
    const rawReason = "bare access-one must not survive this operator reason";

    await disconnectJifengConnection({
      actor: actor(admin.id),
      now: new Date(startedAt.getTime() + 1_000),
      reason: rawReason,
    });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_DISCONNECTED"));
    expect(audit.reason).toBe("操作原因已提供，但因凭据不可读取而未保存原文");
    expect(JSON.stringify(audit)).not.toMatch(/access-one|must not survive/i);
  });

  test("audits the exact persisted status when disabling a refresh-required connection", async () => {
    const admin = await createAdmin("disable-refresh-required");
    await authorizeFixture(admin.id, {
      tokens: { ...tokenSet("old"), expireIn: 1 },
    });
    await expect(
      refreshJifengConnection({
        now: new Date(startedAt.getTime() + 2_000),
        port: { async refresh() { throw new Error("safe refresh failure"); } },
      }),
    ).rejects.toMatchObject({ code: "REFRESH_FAILED" });

    await setJifengFulfillmentEnabled({
      actor: actor(admin.id),
      enabled: false,
      now: new Date(startedAt.getTime() + 3_000),
      reason: "keep fulfillment blocked after refresh failure",
    });

    const [stored] = await db.select().from(jifengConnections);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "JIFENG_FULFILLMENT_DISABLED"));
    expect(stored.status).toBe("REFRESH_REQUIRED");
    expect(audit.afterJson).toEqual({ status: "REFRESH_REQUIRED" });
  });

  test("returns role-appropriate redacted admin and public projections", async () => {
    const admin = await createAdmin("queries");
    await authorizeFixture(admin.id);

    const adminView = await getJifengConnectionAdminView();
    const publicStatus = await getJifengConnectionPublicStatus();
    expect(adminView).toMatchObject({
      authorizedAt: startedAt,
      authorizedByAdminUserId: admin.id,
      status: "READY_DISABLED",
    });
    expect(publicStatus).toEqual({
      connected: true,
      fulfillmentEnabled: false,
      lastDiagnosticAt: null,
      status: "READY_DISABLED",
    });
    expect(JSON.stringify({ adminView, publicStatus })).not.toMatch(
      /access-one|refresh-one|client-secret|owner@example|authorization-code/i,
    );
  });

  test("does not project an unsafe stored error summary", async () => {
    await db.insert(jifengConnections).values({
      connectionKey: "PRIMARY",
      lastErrorCode: "PROVIDER_ERROR",
      lastErrorSummary: "provider returned access-one and owner@example.test",
      status: "ERROR",
    });

    const view = await getJifengConnectionAdminView();
    expect(view.lastError).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(JSON.stringify(view)).not.toMatch(/access-one|owner@example/i);
  });
});

describe("Jifeng token refresh single-flight", () => {
  beforeEach(() => {
    process.env.JIFENG_BASE_URL = "https://jifeng.example.test";
    process.env.JIFENG_CLIENT_ID = "client-id";
    process.env.JIFENG_CLIENT_SECRET = "client-secret-never-persist";
    process.env.JIFENG_TOKEN_ENCRYPTION_KEY = keyText;
  });

  afterEach(async () => {
    await db.execute(sql.raw(`
      truncate table
        jifeng_authorization_attempts,
        jifeng_connections,
        audit_logs,
        admin_users
      restart identity cascade
    `));
  });

  test("allows only one remote refresh and makes the waiter reuse committed credentials", async () => {
    const admin = await createAdmin("refresh-single-flight");
    await authorizeFixture(admin.id, {
      tokens: { ...tokenSet("old"), expireIn: 1 },
    });
    let remoteCalls = 0;
    let releaseRemote!: () => void;
    const remoteGate = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    const port = {
      async refresh() {
        remoteCalls += 1;
        await remoteGate;
        return tokenSet("new");
      },
    };
    const now = new Date(startedAt.getTime() + 2_000);

    const first = refreshJifengConnection({ now, port });
    await expect.poll(() => remoteCalls).toBe(1);
    const second = refreshJifengConnection({ now, port });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(remoteCalls).toBe(1);
    releaseRemote();

    const [left, right] = await Promise.all([first, second]);
    expect(left).toMatchObject({ accessToken: "access-new" });
    expect(right).toMatchObject({ accessToken: "access-new" });
    expect(remoteCalls).toBe(1);
  });

  test("marks refresh required without clearing encrypted token material", async () => {
    const admin = await createAdmin("refresh-failure");
    await authorizeFixture(admin.id, {
      tokens: { ...tokenSet("old"), expireIn: 1 },
    });
    const [before] = await db.select().from(jifengConnections);

    await expect(
      refreshJifengConnection({
        now: new Date(startedAt.getTime() + 2_000),
        port: { async refresh() { throw new Error("refresh-old secret leak"); } },
      }),
    ).rejects.toMatchObject({ code: "REFRESH_FAILED" });

    const [after] = await db.select().from(jifengConnections);
    expect(after).toMatchObject({
      accessTokenEncrypted: before.accessTokenEncrypted,
      refreshTokenEncrypted: before.refreshTokenEncrypted,
      status: "REFRESH_REQUIRED",
    });
    expect(after.lastErrorSummary).not.toMatch(/refresh-old|secret leak/i);
  });

  test("does not let a failed refresh overwrite a concurrent disconnect", async () => {
    const admin = await createAdmin("refresh-disconnect-race");
    await authorizeFixture(admin.id, {
      tokens: { ...tokenSet("old"), expireIn: 1 },
    });
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refresh = refreshJifengConnection({
      now: new Date(startedAt.getTime() + 2_000),
      port: {
        async refresh() {
          refreshStarted();
          await gate;
          throw new Error("safe refresh failure");
        },
      },
    });
    await started;
    try {
      await disconnectJifengConnection({
        actor: actor(admin.id),
        now: new Date(startedAt.getTime() + 3_000),
        reason: "disconnect wins over stale refresh failure",
      });
    } finally {
      releaseRefresh();
    }

    await expect(refresh).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    const [stored] = await db.select().from(jifengConnections);
    expect(stored).toMatchObject({
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      status: "DISCONNECTED",
      userId: null,
    });
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "JIFENG_TOKEN_REFRESH_FAILED")),
    ).toEqual([]);
  });

  test("does not let a failed refresh overwrite concurrent reauthorization", async () => {
    const admin = await createAdmin("refresh-reauthorize-race");
    await authorizeFixture(admin.id, {
      tokens: { ...tokenSet("old"), expireIn: 1 },
    });
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refresh = refreshJifengConnection({
      now: new Date(startedAt.getTime() + 2_000),
      port: {
        async refresh() {
          refreshStarted();
          await gate;
          throw new Error("safe refresh failure");
        },
      },
    });
    await started;
    try {
      await authorizeFixture(admin.id, { tokens: tokenSet("replacement") });
    } finally {
      releaseRefresh();
    }

    await expect(refresh).rejects.toMatchObject({ code: "CONNECTION_CHANGED" });
    const [stored] = await db.select().from(jifengConnections);
    expect(stored).toMatchObject({ status: "READY_DISABLED", userId: "user-replacement" });
    expect(
      decryptJifengSecret(stored.accessTokenEncrypted!, encryptionKey),
    ).toBe("access-replacement");
    expect(
      decryptJifengSecret(stored.refreshTokenEncrypted!, encryptionKey),
    ).toBe("refresh-replacement");
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "JIFENG_TOKEN_REFRESH_FAILED")),
    ).toEqual([]);
  });

  test("moves an undecryptable credential to ERROR while preserving ciphertext", async () => {
    const admin = await createAdmin("corrupted-credential");
    await authorizeFixture(admin.id);
    const [before] = await db.select().from(jifengConnections);
    await db
      .update(jifengConnections)
      .set({
        accessTokenEncrypted: {
          ...before.accessTokenEncrypted!,
          tag: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      })
      .where(eq(jifengConnections.connectionKey, "PRIMARY"));

    await expect(refreshJifengConnection({ now: startedAt })).rejects.toMatchObject({
      code: "CREDENTIALS_INVALID",
    });

    const [after] = await db.select().from(jifengConnections);
    expect(after).toMatchObject({
      accessTokenEncrypted: {
        ...before.accessTokenEncrypted,
        tag: "AAAAAAAAAAAAAAAAAAAAAA",
      },
      fulfillmentEnabledAt: null,
      status: "ERROR",
    });
  });
});
