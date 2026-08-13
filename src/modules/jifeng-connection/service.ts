import { and, eq, gte, sql } from "drizzle-orm";
import postgres from "postgres";

import { db } from "@/db/client";
import {
  auditLogs,
  jifengAuthorizationAttempts,
  jifengConnections,
} from "@/db/schema";
import { JifengClient } from "@/integrations/jifeng/client";
import {
  normalizeJifengBaseUrl,
  readJifengDeveloperConfig,
} from "@/integrations/jifeng/config";
import {
  authorizeJifengUser,
  exchangeJifengAuthorizationCode,
  refreshJifengTokenSet,
} from "@/integrations/jifeng/oauth-client";
import { classifyCanadaPostCandidates } from "@/integrations/jifeng/resources";
import type {
  JifengOfflineLogistics,
  JifengRefreshInput,
  JifengTokenSet,
  JifengWarehouse,
} from "@/integrations/jifeng/types";
import { resolveAdminUserId } from "@/modules/identity/admin-profile";
import type { SuperAdminPrincipal } from "@/modules/identity/principal";
import { redactSensitiveText } from "@/shared/privacy";

import {
  decryptJifengSecret,
  encryptJifengSecret,
  JifengSecretError,
  parseJifengEncryptionKey,
} from "./crypto";
import {
  getJifengConnectionAdminView,
  type JifengConnectionAdminView,
} from "./queries";
import type { EncryptedSecret, JifengConnectionStatus } from "./types";

const PRIMARY_KEY = "PRIMARY";
const AUTHORIZATION_LIMIT = 5;
const AUTHORIZATION_WINDOW_MS = 10 * 60_000;
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const REFRESH_ADVISORY_LOCK_KEY = 1_466_381_947;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const refreshDatabase = postgres(connectionString, { idle_timeout: 1, max: 10 });

export type JifengResourceDiscovery = {
  logistics: JifengOfflineLogistics[];
  warehouses: JifengWarehouse[];
};

export type JifengRuntimeCredentials = {
  accessToken: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  logisticsId: number | null;
  refreshToken: string;
  userId: string;
  warehouseCode: string | null;
};

export type JifengAuthorizationPort = {
  authorize(input: {
    baseUrl: string;
    clientId: string;
    domain: string;
    email: string;
    oneTimeToken: string;
  }): Promise<{ authorizationCode: string }>;
  discoverResources(
    credentials: JifengRuntimeCredentials,
  ): Promise<JifengResourceDiscovery>;
  exchangeAuthorizationCode(input: {
    authorizationCode: string;
    baseUrl: string;
    clientId: string;
    clientSecret: string;
  }): Promise<JifengTokenSet>;
};

export type JifengRefreshPort = {
  refresh(input: JifengRefreshInput): Promise<JifengTokenSet>;
};

export type RefreshOptions = {
  now?: Date;
  port?: JifengRefreshPort;
};

export type DiscoveryInput = {
  actor: SuperAdminPrincipal;
  now?: Date;
  port?: {
    discoverResources(
      credentials: JifengRuntimeCredentials,
    ): Promise<JifengResourceDiscovery>;
  };
};

export type ResourceSelectionInput = {
  actor: SuperAdminPrincipal;
  logistics: JifengOfflineLogistics;
  now?: Date;
  warehouse: JifengWarehouse;
};

export type JifengDiagnosticView = {
  code?: string;
  ok: boolean;
  ranAt: Date;
};

export type DiagnosticInput = {
  actor: SuperAdminPrincipal;
  now?: Date;
  port?: {
    run(credentials: JifengRuntimeCredentials): Promise<{
      code?: string;
      ok: boolean;
    }>;
  };
};

export type ActivationInput = {
  actor: SuperAdminPrincipal;
  enabled: boolean;
  now?: Date;
  reason: string;
};

export type DisconnectInput = {
  actor: SuperAdminPrincipal;
  now?: Date;
  reason: string;
};

export class JifengConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JifengConnectionError";
    this.code = code;
  }
}

function connectionError(code: string, message: string): never {
  throw new JifengConnectionError(code, message);
}

function assertSuperAdmin(actor: SuperAdminPrincipal) {
  if (actor?.kind !== "SUPER_ADMIN" || !actor.userId?.trim()) {
    connectionError("FORBIDDEN", "仅超级管理员可以管理极风连接");
  }
}

async function resolveActorAdminUserId(authUserId: string) {
  try {
    return await resolveAdminUserId(authUserId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "ADMIN_PROFILE_NOT_FOUND"
    ) {
      connectionError(
        "ADMIN_PROFILE_NOT_FOUND",
        "Active administrator profile is required",
      );
    }
    throw error;
  }
}

function requireReason(reason: string) {
  const normalized = reason.trim();
  if (!normalized) connectionError("REASON_REQUIRED", "必须填写操作原因");
  return normalized;
}

function sanitizeAuditReason(
  reason: string,
  row: {
    accessTokenEncrypted: EncryptedSecret | null;
    refreshTokenEncrypted: EncryptedSecret | null;
  },
) {
  const sensitiveValues = [process.env.JIFENG_CLIENT_SECRET];
  try {
    const key = parseJifengEncryptionKey();
    if (row.accessTokenEncrypted) {
      sensitiveValues.push(decryptJifengSecret(row.accessTokenEncrypted, key));
    }
    if (row.refreshTokenEncrypted) {
      sensitiveValues.push(decryptJifengSecret(row.refreshTokenEncrypted, key));
    }
  } catch {
    return "操作原因已提供，但因凭据不可读取而未保存原文";
  }

  let sanitized = redactSensitiveText(reason)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(
      /((?:authorization(?:\s+code)?|access\s*token|refresh\s*token|one[- ]time\s*token|client\s*secret|signature|sign)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]",
    );
  for (const value of sensitiveValues) {
    if (value) sanitized = sanitized.replaceAll(value, "[REDACTED]");
  }
  return sanitized;
}

function getBaseUrl() {
  const raw = process.env.JIFENG_BASE_URL;
  try {
    if (!raw) throw new Error("missing");
    return normalizeJifengBaseUrl(raw, process.env.NODE_ENV);
  } catch {
    connectionError("DEVELOPER_CONFIG_INVALID", "极风服务器配置不完整");
  }
}

function readDeveloperConfiguration() {
  try {
    return { ...readJifengDeveloperConfig(), baseUrl: getBaseUrl() };
  } catch (error) {
    if (error instanceof JifengConnectionError) throw error;
    connectionError("DEVELOPER_CONFIG_INVALID", "极风服务器配置不完整");
  }
}

function expiry(now: Date, seconds: number) {
  return new Date(now.getTime() + seconds * 1_000);
}

function safeErrorCategory(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_-]{1,64}$/.test(error.code)
  ) {
    return error.code;
  }
  return "PROVIDER_ERROR";
}

function authorizationPort(): JifengAuthorizationPort {
  return {
    authorize: authorizeJifengUser,
    async discoverResources(credentials) {
      const client = new JifengClient({ credentials });
      const [warehouses, logistics] = await Promise.all([
        client.getWarehouses(),
        client.getOfflineLogistics(),
      ]);
      return { logistics, warehouses };
    },
    exchangeAuthorizationCode: exchangeJifengAuthorizationCode,
  };
}

function refreshPort(): JifengRefreshPort {
  return { refresh: refreshJifengTokenSet };
}

function selectAutomaticResources(discovery: JifengResourceDiscovery) {
  const warehouses = discovery.warehouses.filter(
    (candidate) => candidate.isAuth !== false,
  );
  const logisticsResult = classifyCanadaPostCandidates(discovery.logistics);
  if (warehouses.length !== 1 || logisticsResult.status !== "MATCHED") {
    return {
      logistics: null,
      status: "RESOURCE_SELECTION_REQUIRED" as const,
      warehouse: null,
    };
  }
  return {
    logistics: logisticsResult.candidate,
    status: "READY_DISABLED" as const,
    warehouse: warehouses[0],
  };
}

async function reserveAuthorizationAttempt(input: {
  actorId: string;
  adminUserId: string;
  now: Date;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(1466381946, hashtext(${input.adminUserId}))`,
    );
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(jifengAuthorizationAttempts)
      .where(
        and(
          eq(jifengAuthorizationAttempts.adminUserId, input.adminUserId),
          gte(
            jifengAuthorizationAttempts.attemptedAt,
            new Date(input.now.getTime() - AUTHORIZATION_WINDOW_MS),
          ),
        ),
      );
    if (count >= AUTHORIZATION_LIMIT) {
      connectionError(
        "AUTHORIZATION_RATE_LIMITED",
        "授权尝试过于频繁，请稍后重试",
      );
    }
    const [attempt] = await tx
      .insert(jifengAuthorizationAttempts)
      .values({
        adminUserId: input.adminUserId,
        attemptedAt: input.now,
        errorCategory: "IN_PROGRESS",
        result: "FAILED",
      })
      .returning({ id: jifengAuthorizationAttempts.id });
    await tx.insert(auditLogs).values({
      action: "JIFENG_OAUTH_STARTED",
      actorId: input.actorId,
      actorType: "ADMIN",
      afterJson: { status: "STARTED" },
      beforeJson: {},
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: "超级管理员开始极风授权",
    });
    return attempt.id;
  });
}

async function recordAuthorizationFailure(input: {
  actorId: string;
  attemptId: string;
  category: string;
}) {
  await db.transaction(async (tx) => {
    await tx
      .update(jifengAuthorizationAttempts)
      .set({ errorCategory: input.category, result: "FAILED" })
      .where(eq(jifengAuthorizationAttempts.id, input.attemptId));
    await tx.insert(auditLogs).values({
      action: "JIFENG_OAUTH_FAILED",
      actorId: input.actorId,
      actorType: "ADMIN",
      afterJson: { errorCategory: input.category, status: "FAILED" },
      beforeJson: {},
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: "极风授权未完成",
    });
  });
}

export async function authorizeJifengConnection(input: {
  actor: SuperAdminPrincipal;
  email: string;
  now?: Date;
  oneTimeToken: string;
  port?: JifengAuthorizationPort;
}): Promise<JifengConnectionAdminView> {
  assertSuperAdmin(input.actor);
  const adminUserId = await resolveActorAdminUserId(input.actor.userId);
  const now = input.now ?? new Date();
  const attemptId = await reserveAuthorizationAttempt({
    actorId: input.actor.userId,
    adminUserId,
    now,
  });
  let developer: ReturnType<typeof readDeveloperConfiguration>;
  try {
    developer = readDeveloperConfiguration();
  } catch (error) {
    await recordAuthorizationFailure({
      actorId: input.actor.userId,
      attemptId,
      category: safeErrorCategory(error),
    });
    throw error;
  }
  const port = input.port ?? authorizationPort();

  let tokenSet: JifengTokenSet;
  let discovery: JifengResourceDiscovery;
  try {
    const authorization = await port.authorize({
      baseUrl: developer.baseUrl,
      clientId: developer.clientId,
      domain: new URL(developer.baseUrl).hostname,
      email: input.email,
      oneTimeToken: input.oneTimeToken,
    });
    tokenSet = await port.exchangeAuthorizationCode({
      authorizationCode: authorization.authorizationCode,
      baseUrl: developer.baseUrl,
      clientId: developer.clientId,
      clientSecret: developer.clientSecret,
    });
    discovery = await port.discoverResources({
      accessToken: tokenSet.accessToken,
      baseUrl: developer.baseUrl,
      clientId: developer.clientId,
      clientSecret: developer.clientSecret,
      logisticsId: null,
      refreshToken: tokenSet.refreshToken,
      userId: tokenSet.userId,
      warehouseCode: null,
    });
  } catch (error) {
    await recordAuthorizationFailure({
      actorId: input.actor.userId,
      attemptId,
      category: safeErrorCategory(error),
    });
    connectionError("AUTHORIZATION_FAILED", "极风授权失败，请重新获取一次性令牌");
  }

  let accessTokenEncrypted: EncryptedSecret;
  let refreshTokenEncrypted: EncryptedSecret;
  try {
    const key = parseJifengEncryptionKey();
    accessTokenEncrypted = encryptJifengSecret(tokenSet.accessToken, key);
    refreshTokenEncrypted = encryptJifengSecret(tokenSet.refreshToken, key);
  } catch {
    await recordAuthorizationFailure({
      actorId: input.actor.userId,
      attemptId,
      category: "ENCRYPTION_FAILED",
    });
    connectionError("AUTHORIZATION_FAILED", "极风授权失败，请重新获取一次性令牌");
  }
  const selected = selectAutomaticResources(discovery);

  await db.transaction(async (tx) => {
    await tx
      .insert(jifengConnections)
      .values({ connectionKey: PRIMARY_KEY })
      .onConflictDoNothing({ target: jifengConnections.connectionKey });
    const [before] = await tx
      .select({ status: jifengConnections.status })
      .from(jifengConnections)
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
      .for("update");
    await tx
      .update(jifengConnections)
      .set({
        accessTokenEncrypted,
        accessTokenExpiresAt: expiry(now, tokenSet.expireIn),
        authorizedAt: now,
        authorizedByAdminUserId: adminUserId,
        fulfillmentEnabledAt: null,
        fulfillmentEnabledByAdminUserId: null,
        lastDiagnosticAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        logisticsId: selected.logistics?.id ?? null,
        logisticsName: selected.logistics?.name ?? null,
        refreshTokenEncrypted,
        refreshTokenExpiresAt: expiry(now, tokenSet.refreshExpireIn),
        status: selected.status,
        updatedAt: now,
        userId: tokenSet.userId,
        warehouseCode: selected.warehouse?.code ?? null,
        warehouseName: selected.warehouse?.name ?? null,
      })
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
    await tx
      .update(jifengAuthorizationAttempts)
      .set({ errorCategory: null, result: "SUCCEEDED" })
      .where(eq(jifengAuthorizationAttempts.id, attemptId));
    await tx.insert(auditLogs).values({
      action: "JIFENG_OAUTH_AUTHORIZED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        logisticsId: selected.logistics?.id ?? null,
        status: selected.status,
        warehouseCode: selected.warehouse?.code ?? null,
      },
      beforeJson: { status: before.status },
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: "极风授权成功并完成只读资源发现",
    });
  });
  return getJifengConnectionAdminView();
}

type StoredCredentialRow = {
  access_token_encrypted: EncryptedSecret | null;
  access_token_expires_at: Date | null;
  logistics_id: number | null;
  refresh_token_encrypted: EncryptedSecret | null;
  refresh_token_expires_at: Date | null;
  status: JifengConnectionStatus;
  updated_at: Date;
  user_id: string | null;
  warehouse_code: string | null;
};

function decryptRuntimeCredentials(row: StoredCredentialRow) {
  if (
    !row.access_token_encrypted ||
    !row.refresh_token_encrypted ||
    !row.user_id
  ) {
    connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
  }
  const key = parseJifengEncryptionKey();
  const developer = readDeveloperConfiguration();
  return {
    accessToken: decryptJifengSecret(row.access_token_encrypted, key),
    baseUrl: developer.baseUrl,
    clientId: developer.clientId,
    clientSecret: developer.clientSecret,
    logisticsId: row.logistics_id,
    refreshToken: decryptJifengSecret(row.refresh_token_encrypted, key),
    userId: row.user_id,
    warehouseCode: row.warehouse_code,
  } satisfies JifengRuntimeCredentials;
}

function isAccessTokenUsable(row: StoredCredentialRow, now: Date) {
  return (
    row.access_token_expires_at !== null &&
    row.access_token_expires_at.getTime() >
      now.getTime() + ACCESS_TOKEN_REFRESH_MARGIN_MS
  );
}

async function withRefreshAdvisoryLock<T>(work: (connection: Awaited<ReturnType<typeof refreshDatabase.reserve>>) => Promise<T>) {
  const connection = await refreshDatabase.reserve();
  try {
    await connection`select pg_advisory_lock(${REFRESH_ADVISORY_LOCK_KEY})`;
    return await work(connection);
  } finally {
    try {
      await connection`select pg_advisory_unlock(${REFRESH_ADVISORY_LOCK_KEY})`;
    } finally {
      connection.release();
    }
  }
}

async function withReservedTransaction<T>(
  connection: Awaited<ReturnType<typeof refreshDatabase.reserve>>,
  work: (
    transaction: Awaited<ReturnType<typeof refreshDatabase.reserve>>,
  ) => Promise<T>,
) {
  await connection`begin`;
  try {
    const result = await work(connection);
    await connection`commit`;
    return result;
  } catch (error) {
    await connection`rollback`;
    throw error;
  }
}

async function readStoredCredentials(
  connection: Awaited<ReturnType<typeof refreshDatabase.reserve>>,
) {
  const [row] = await connection<StoredCredentialRow[]>`
    select access_token_encrypted, access_token_expires_at, logistics_id,
           refresh_token_encrypted, refresh_token_expires_at, status, user_id,
           updated_at, warehouse_code
    from jifeng_connections
    where connection_key = ${PRIMARY_KEY}
  `;
  if (!row) connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
  if (row.status === "DISCONNECTED" || row.status === "ERROR") {
    connectionError("AUTHORIZATION_REQUIRED", "极风连接当前不可用");
  }
  if (row.status === "REFRESH_REQUIRED") {
    connectionError("REFRESH_REQUIRED", "极风连接需要重新授权");
  }
  return row;
}

async function readConnectionRevision() {
  const [row] = await db
    .select({
      status: jifengConnections.status,
      updatedAt: jifengConnections.updatedAt,
    })
    .from(jifengConnections)
    .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
    .limit(1);
  if (
    !row ||
    row.status === "DISCONNECTED" ||
    row.status === "ERROR" ||
    row.status === "REFRESH_REQUIRED"
  ) {
    connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
  }
  return row.updatedAt;
}

async function loadPersistedJifengRuntime(
  input: RefreshOptions = {},
) {
  const now = input.now ?? new Date();
  return withRefreshAdvisoryLock(async (connection) => {
    const row = await readStoredCredentials(connection);
    if (isAccessTokenUsable(row, now)) {
      try {
        return { credentials: decryptRuntimeCredentials(row), source: row };
      } catch (error) {
        if (!(error instanceof JifengSecretError)) throw error;
        const recorded = await markCredentialFailure(connection, now, row);
        if (!recorded) {
          connectionError("CONNECTION_CHANGED", "极风连接已变更，已丢弃过期失败结果");
        }
        connectionError("CREDENTIALS_INVALID", "极风授权凭据无法安全读取");
      }
    }
    if (
      !row.refresh_token_expires_at ||
      row.refresh_token_expires_at.getTime() <= now.getTime()
    ) {
      const recorded = await markRefreshFailure(
        connection,
        now,
        "REFRESH_TOKEN_EXPIRED",
        row,
      );
      if (!recorded) {
        connectionError("CONNECTION_CHANGED", "极风连接已变更，已丢弃过期失败结果");
      }
      connectionError("REFRESH_FAILED", "极风令牌刷新失败，需要重新授权");
    }

    let current: JifengRuntimeCredentials;
    try {
      current = decryptRuntimeCredentials(row);
    } catch (error) {
      if (!(error instanceof JifengSecretError)) throw error;
      const recorded = await markCredentialFailure(connection, now, row);
      if (!recorded) {
        connectionError("CONNECTION_CHANGED", "极风连接已变更，已丢弃过期失败结果");
      }
      connectionError("CREDENTIALS_INVALID", "极风授权凭据无法安全读取");
    }
    let refreshed: JifengTokenSet;
    try {
      refreshed = await (input.port ?? refreshPort()).refresh({
        baseUrl: current.baseUrl,
        clientId: current.clientId,
        clientSecret: current.clientSecret,
        refreshToken: current.refreshToken,
        userId: current.userId,
      });
    } catch (error) {
      const recorded = await markRefreshFailure(
        connection,
        now,
        safeErrorCategory(error),
        row,
      );
      if (!recorded) {
        connectionError("CONNECTION_CHANGED", "极风连接已变更，已丢弃过期失败结果");
      }
      connectionError("REFRESH_FAILED", "极风令牌刷新失败，需要重新授权");
    }

    const key = parseJifengEncryptionKey();
    const encryptedAccess = encryptJifengSecret(refreshed.accessToken, key);
    const encryptedRefresh = encryptJifengSecret(refreshed.refreshToken, key);
    const committedRows = await withReservedTransaction(connection, async (tx) => {
      const [locked] = await tx<StoredCredentialRow[]>`
        select access_token_encrypted, access_token_expires_at, logistics_id,
               refresh_token_encrypted, refresh_token_expires_at, status, user_id,
               updated_at, warehouse_code
        from jifeng_connections
        where connection_key = ${PRIMARY_KEY}
        for update
      `;
      if (!locked) return [];
      if (
        JSON.stringify(locked.refresh_token_encrypted) !==
        JSON.stringify(row.refresh_token_encrypted)
      ) {
        return [locked];
      }
      return tx<StoredCredentialRow[]>`
        update jifeng_connections
        set access_token_encrypted = ${tx.json(encryptedAccess)},
            refresh_token_encrypted = ${tx.json(encryptedRefresh)},
            access_token_expires_at = ${expiry(now, refreshed.expireIn)},
            refresh_token_expires_at = ${expiry(now, refreshed.refreshExpireIn)},
            user_id = ${refreshed.userId},
            last_refreshed_at = ${now},
            last_error_code = null,
            last_error_summary = null
        where connection_key = ${PRIMARY_KEY}
        returning access_token_encrypted, access_token_expires_at, logistics_id,
                  refresh_token_encrypted, refresh_token_expires_at, status,
                  updated_at, user_id, warehouse_code
      `;
    });
    const [committed] = committedRows;
    if (!committed) connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
    return {
      credentials: decryptRuntimeCredentials(committed),
      source: committed,
    };
  });
}

export async function refreshJifengConnection(
  input: RefreshOptions = {},
): Promise<JifengRuntimeCredentials> {
  return (await loadPersistedJifengRuntime(input)).credentials;
}

function hasSameCredentialRevision(
  current: StoredCredentialRow,
  source: StoredCredentialRow,
) {
  return (
    current.status === source.status &&
    current.updated_at.getTime() === source.updated_at.getTime() &&
    JSON.stringify(current.access_token_encrypted) ===
      JSON.stringify(source.access_token_encrypted) &&
    JSON.stringify(current.refresh_token_encrypted) ===
      JSON.stringify(source.refresh_token_encrypted)
  );
}

async function markCredentialFailure(
  connection: Awaited<ReturnType<typeof refreshDatabase.reserve>>,
  now: Date,
  source: StoredCredentialRow,
) {
  return withReservedTransaction(connection, async (tx) => {
    const [before] = await tx<StoredCredentialRow[]>`
      select access_token_encrypted, access_token_expires_at, logistics_id,
             refresh_token_encrypted, refresh_token_expires_at, status,
             updated_at, user_id, warehouse_code
      from jifeng_connections
      where connection_key = ${PRIMARY_KEY}
      for update
    `;
    if (!before || !hasSameCredentialRevision(before, source)) {
      return false;
    }
    await tx`
      update jifeng_connections
      set status = 'ERROR',
          fulfillment_enabled_at = null,
          fulfillment_enabled_by_admin_user_id = null,
          last_error_code = 'CREDENTIALS_INVALID',
          last_error_summary = '极风授权凭据无法安全读取',
          updated_at = ${now}
      where connection_key = ${PRIMARY_KEY}
    `;
    await tx`
      insert into audit_logs (
        actor_type, action, entity_type, entity_id, before_json, after_json, reason
      ) values (
        'SYSTEM', 'JIFENG_CREDENTIALS_INVALID', 'JIFENG_CONNECTION', ${PRIMARY_KEY},
        ${tx.json({ status: before.status })},
        ${tx.json({ errorCategory: "CREDENTIALS_INVALID", status: "ERROR" })},
        '极风授权凭据无法安全读取，已阻止新的履约写入'
      )
    `;
    return true;
  });
}

async function markRefreshFailure(
  connection: Awaited<ReturnType<typeof refreshDatabase.reserve>>,
  now: Date,
  category: string,
  source: StoredCredentialRow,
) {
  return withReservedTransaction(connection, async (tx) => {
    const [before] = await tx<StoredCredentialRow[]>`
      select access_token_encrypted, access_token_expires_at, logistics_id,
             refresh_token_encrypted, refresh_token_expires_at, status,
             updated_at, user_id, warehouse_code
      from jifeng_connections
      where connection_key = ${PRIMARY_KEY}
      for update
    `;
    if (!before || !hasSameCredentialRevision(before, source)) return false;
    await tx`
      update jifeng_connections
      set status = 'REFRESH_REQUIRED',
          last_error_code = ${category},
          last_error_summary = '极风令牌刷新失败，需要重新授权',
          updated_at = ${now}
      where connection_key = ${PRIMARY_KEY}
    `;
    await tx`
      insert into audit_logs (
        actor_type, action, entity_type, entity_id, before_json, after_json, reason
      ) values (
        'SYSTEM', 'JIFENG_TOKEN_REFRESH_FAILED', 'JIFENG_CONNECTION', ${PRIMARY_KEY},
        ${tx.json({ status: before.status })},
        ${tx.json({ errorCategory: category, status: "REFRESH_REQUIRED" })},
        '极风令牌刷新失败，已阻止新的履约写入'
      )
    `;
    return true;
  });
}

async function markRuntimeAuthenticationRejected(
  connection: Awaited<ReturnType<typeof refreshDatabase.reserve>>,
  source: StoredCredentialRow,
) {
  const nextUpdatedAt = new Date(
    Math.max(Date.now(), source.updated_at.getTime() + 1),
  );
  return withReservedTransaction(connection, async (tx) => {
    const [before] = await tx<StoredCredentialRow[]>`
      select access_token_encrypted, access_token_expires_at, logistics_id,
             refresh_token_encrypted, refresh_token_expires_at, status,
             updated_at, user_id, warehouse_code
      from jifeng_connections
      where connection_key = ${PRIMARY_KEY}
      for update
    `;
    if (!before || !hasSameCredentialRevision(before, source)) return false;
    await tx`
      update jifeng_connections
      set status = 'REFRESH_REQUIRED',
          last_error_code = 'ACCESS_TOKEN_REJECTED',
          last_error_summary = '极风访问令牌已失效，需要重新授权',
          updated_at = ${nextUpdatedAt}
      where connection_key = ${PRIMARY_KEY}
    `;
    await tx`
      insert into audit_logs (
        actor_type, action, entity_type, entity_id, before_json, after_json, reason
      ) values (
        'SYSTEM', 'JIFENG_RUNTIME_AUTH_REJECTED', 'JIFENG_CONNECTION', ${PRIMARY_KEY},
        ${tx.json({ status: before.status })},
        ${tx.json({ errorCategory: "ACCESS_TOKEN_REJECTED", status: "REFRESH_REQUIRED" })},
        '极风运行时访问令牌被拒绝，已阻止后续履约写入'
      )
    `;
    return true;
  });
}

export async function getPersistedJifengRuntime(
  input: RefreshOptions = {},
) {
  const runtime = await loadPersistedJifengRuntime(input);
  return {
    credentials: runtime.credentials,
    async onAuthenticationRejected() {
      await withRefreshAdvisoryLock(async (connection) => {
        await markRuntimeAuthenticationRejected(connection, runtime.source);
      });
    },
  };
}

async function applyDiscovery(input: {
  actorId: string;
  discovery: JifengResourceDiscovery;
  expectedUpdatedAt: Date;
  now: Date;
}) {
  const selected = selectAutomaticResources(input.discovery);
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        status: jifengConnections.status,
        updatedAt: jifengConnections.updatedAt,
      })
      .from(jifengConnections)
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
      .for("update");
    if (
      !before ||
      before.status === "DISCONNECTED" ||
      before.status === "ERROR" ||
      before.status === "REFRESH_REQUIRED" ||
      before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    ) {
      connectionError("CONNECTION_CHANGED", "极风连接已变更，请重新发现资源");
    }
    await tx
      .update(jifengConnections)
      .set({
        fulfillmentEnabledAt: null,
        fulfillmentEnabledByAdminUserId: null,
        lastDiagnosticAt: null,
        logisticsId: selected.logistics?.id ?? null,
        logisticsName: selected.logistics?.name ?? null,
        status: selected.status,
        updatedAt: input.now,
        warehouseCode: selected.warehouse?.code ?? null,
        warehouseName: selected.warehouse?.name ?? null,
      })
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
    await tx.insert(auditLogs).values({
      action: "JIFENG_RESOURCES_DISCOVERED",
      actorId: input.actorId,
      actorType: "ADMIN",
      afterJson: {
        logisticsCandidates: input.discovery.logistics.length,
        status: selected.status,
        warehouseCandidates: input.discovery.warehouses.length,
      },
      beforeJson: { status: before.status },
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: "重新发现极风只读资源",
    });
  });
}

export async function discoverJifengResources(
  input: DiscoveryInput,
): Promise<JifengResourceDiscovery> {
  assertSuperAdmin(input.actor);
  const now = input.now ?? new Date();
  const credentials = await refreshJifengConnection({ now });
  const expectedUpdatedAt = await readConnectionRevision();
  const discovery = await (
    input.port ?? authorizationPort()
  ).discoverResources(credentials);
  await applyDiscovery({
    actorId: input.actor.userId,
    discovery,
    expectedUpdatedAt,
    now,
  });
  return discovery;
}

export async function selectJifengResources(
  input: ResourceSelectionInput,
): Promise<void> {
  assertSuperAdmin(input.actor);
  const now = input.now ?? new Date();
  if (!input.warehouse.code.trim() || !input.logistics.name.trim()) {
    connectionError("RESOURCE_INVALID", "必须选择有效的仓库和物流渠道");
  }
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: jifengConnections.status })
      .from(jifengConnections)
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
      .for("update");
    if (
      !before ||
      before.status === "DISCONNECTED" ||
      before.status === "ERROR" ||
      before.status === "REFRESH_REQUIRED"
    ) {
      connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
    }
    await tx
      .update(jifengConnections)
      .set({
        fulfillmentEnabledAt: null,
        fulfillmentEnabledByAdminUserId: null,
        lastDiagnosticAt: null,
        logisticsId: input.logistics.id,
        logisticsName: input.logistics.name,
        status: "READY_DISABLED",
        updatedAt: now,
        warehouseCode: input.warehouse.code,
        warehouseName: input.warehouse.name,
      })
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
    await tx.insert(auditLogs).values({
      action: "JIFENG_RESOURCES_SELECTED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: {
        logisticsId: input.logistics.id,
        status: "READY_DISABLED",
        warehouseCode: input.warehouse.code,
      },
      beforeJson: { status: before.status },
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: "超级管理员确认极风仓库和物流渠道",
    });
  });
}

export async function runStoredJifengDiagnostic(
  input: DiagnosticInput,
): Promise<JifengDiagnosticView> {
  assertSuperAdmin(input.actor);
  const now = input.now ?? new Date();
  const credentials = await refreshJifengConnection({ now });
  const expectedUpdatedAt = await readConnectionRevision();
  let result: { code?: string; ok: boolean };
  try {
    result = await (
      input.port ?? {
        async run(runtime: JifengRuntimeCredentials) {
          try {
            await new JifengClient({
              credentials: { ...runtime, refreshToken: undefined },
            }).getOrder({
              erpNo: `JIFENG-CONNECTION-DIAGNOSTIC-${now.getTime()}`,
            });
            return { ok: true };
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              (error.code === "50017" || error.code === "50071")
            ) {
              return { code: String(error.code), ok: true };
            }
            throw error;
          }
        },
      }
    ).run(credentials);
  } catch {
    result = { code: "PROVIDER_ERROR", ok: false };
  }
  const safeCode = result.code && /^[A-Z0-9_-]{1,64}$/.test(result.code)
    ? result.code
    : result.ok
      ? undefined
      : "DIAGNOSTIC_FAILED";
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        status: jifengConnections.status,
        updatedAt: jifengConnections.updatedAt,
      })
      .from(jifengConnections)
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
      .for("update");
    if (!row) connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
    if (
      row.status === "DISCONNECTED" ||
      row.status === "ERROR" ||
      row.status === "REFRESH_REQUIRED" ||
      row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
    ) {
      connectionError("DIAGNOSTIC_STALE", "诊断期间极风资源已变更，请重新运行");
    }
    await tx
      .update(jifengConnections)
      .set({
        lastDiagnosticAt: result.ok ? now : null,
        lastErrorCode: safeCode ?? null,
        lastErrorSummary: result.ok ? null : "极风只读诊断未通过",
      })
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
    await tx.insert(auditLogs).values({
      action: "JIFENG_DIAGNOSTIC_RUN",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: { code: safeCode ?? null, ok: result.ok },
      beforeJson: { status: row.status },
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: "运行极风只读连接诊断",
    });
  });
  return { code: safeCode, ok: result.ok, ranAt: now };
}

export async function setJifengFulfillmentEnabled(
  input: ActivationInput,
): Promise<void> {
  assertSuperAdmin(input.actor);
  const reason = requireReason(input.reason);
  const now = input.now ?? new Date();
  let enabledByAdminUserId: string | null = null;
  if (input.enabled) {
    enabledByAdminUserId = await resolveActorAdminUserId(input.actor.userId);
    await refreshJifengConnection({ now });
  }

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(jifengConnections)
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
      .for("update");
    if (!row) connectionError("AUTHORIZATION_REQUIRED", "极风连接尚未完成授权");
    const auditReason = sanitizeAuditReason(reason, row);

    let targetStatus: JifengConnectionStatus;
    if (input.enabled) {
      if (!enabledByAdminUserId) {
        connectionError(
          "ADMIN_PROFILE_NOT_FOUND",
          "Active administrator profile is required",
        );
      }
      if (!row.warehouseCode || row.logisticsId === null) {
        connectionError("RESOURCE_SELECTION_REQUIRED", "必须先确认仓库和物流渠道");
      }
      if (!row.lastDiagnosticAt || row.lastDiagnosticAt < row.updatedAt) {
        connectionError("DIAGNOSTIC_REQUIRED", "资源变更后必须重新通过只读诊断");
      }
      await tx
        .update(jifengConnections)
        .set({
          fulfillmentEnabledAt: now,
          fulfillmentEnabledByAdminUserId: enabledByAdminUserId,
          status: "ENABLED",
        })
        .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
      targetStatus = "ENABLED";
    } else {
      if (row.status === "DISCONNECTED") return;
      targetStatus =
        row.status === "REFRESH_REQUIRED"
          ? "REFRESH_REQUIRED"
          : row.warehouseCode && row.logisticsId !== null
            ? "READY_DISABLED"
            : "RESOURCE_SELECTION_REQUIRED";
      await tx
        .update(jifengConnections)
        .set({
          fulfillmentEnabledAt: null,
          fulfillmentEnabledByAdminUserId: null,
          status: targetStatus,
        })
        .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
    }
    await tx.insert(auditLogs).values({
      action: input.enabled
        ? "JIFENG_FULFILLMENT_ENABLED"
        : "JIFENG_FULFILLMENT_DISABLED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: { status: targetStatus },
      beforeJson: { status: row.status },
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: auditReason,
    });
  });
}

export async function disconnectJifengConnection(
  input: DisconnectInput,
): Promise<void> {
  assertSuperAdmin(input.actor);
  const reason = requireReason(input.reason);
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(jifengConnections)
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY))
      .for("update");
    if (!row || row.status === "DISCONNECTED") return;
    const auditReason = sanitizeAuditReason(reason, row);
    if (row.status === "ENABLED") {
      await tx
        .update(jifengConnections)
        .set({
          fulfillmentEnabledAt: null,
          fulfillmentEnabledByAdminUserId: null,
          status: "READY_DISABLED",
        })
        .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
      await tx.insert(auditLogs).values({
        action: "JIFENG_FULFILLMENT_DISABLED",
        actorId: input.actor.userId,
        actorType: "ADMIN",
        afterJson: { status: "READY_DISABLED" },
        beforeJson: { status: "ENABLED" },
        entityId: PRIMARY_KEY,
        entityType: "JIFENG_CONNECTION",
        reason: auditReason,
      });
    }
    await tx
      .update(jifengConnections)
      .set({
        accessTokenEncrypted: null,
        accessTokenExpiresAt: null,
        authorizedAt: null,
        authorizedByAdminUserId: null,
        fulfillmentEnabledAt: null,
        fulfillmentEnabledByAdminUserId: null,
        lastDiagnosticAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastRefreshedAt: null,
        logisticsId: null,
        logisticsName: null,
        refreshTokenEncrypted: null,
        refreshTokenExpiresAt: null,
        status: "DISCONNECTED",
        updatedAt: now,
        userId: null,
        warehouseCode: null,
        warehouseName: null,
      })
      .where(eq(jifengConnections.connectionKey, PRIMARY_KEY));
    await tx.insert(auditLogs).values({
      action: "JIFENG_DISCONNECTED",
      actorId: input.actor.userId,
      actorType: "ADMIN",
      afterJson: { status: "DISCONNECTED" },
      beforeJson: { status: row.status },
      entityId: PRIMARY_KEY,
      entityType: "JIFENG_CONNECTION",
      reason: auditReason,
    });
  });
}
