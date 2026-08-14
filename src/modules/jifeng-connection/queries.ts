import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { jifengConnections } from "@/db/schema";
import type { JifengConnectionStatus } from "./types";

export type JifengConnectionAdminView = {
  authorizedAt: Date | null;
  authorizedByAdminUserId: string | null;
  fulfillmentEnabled: boolean;
  fulfillmentEnabledAt: Date | null;
  lastDiagnosticAt: Date | null;
  lastError: { code: string; summary: string } | null;
  lastRefreshedAt: Date | null;
  logistics: { id: number; name: string | null } | null;
  status: JifengConnectionStatus;
  userIdMasked: string | null;
  warehouse: { code: string; name: string | null } | null;
};

export type JifengConnectionPublicStatus = {
  connected: boolean;
  fulfillmentEnabled: boolean;
  lastDiagnosticAt: Date | null;
  status: JifengConnectionStatus;
};

function maskIdentifier(value: string | null) {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function safeErrorCode(value: string | null) {
  return value && /^[A-Z0-9_-]{1,80}$/.test(value)
    ? value
    : "UNKNOWN_ERROR";
}

export async function getJifengConnectionAdminView(): Promise<JifengConnectionAdminView> {
  const [row] = await db
    .select({
      authorizedAt: jifengConnections.authorizedAt,
      authorizedByAdminUserId: jifengConnections.authorizedByAdminUserId,
      fulfillmentEnabledAt: jifengConnections.fulfillmentEnabledAt,
      lastDiagnosticAt: jifengConnections.lastDiagnosticAt,
      lastErrorCode: jifengConnections.lastErrorCode,
      lastErrorSummary: jifengConnections.lastErrorSummary,
      lastRefreshedAt: jifengConnections.lastRefreshedAt,
      logisticsId: jifengConnections.logisticsId,
      logisticsName: jifengConnections.logisticsName,
      status: jifengConnections.status,
      userId: jifengConnections.userId,
      warehouseCode: jifengConnections.warehouseCode,
      warehouseName: jifengConnections.warehouseName,
    })
    .from(jifengConnections)
    .where(eq(jifengConnections.connectionKey, "PRIMARY"))
    .limit(1);

  if (!row) {
    return {
      authorizedAt: null,
      authorizedByAdminUserId: null,
      fulfillmentEnabled: false,
      fulfillmentEnabledAt: null,
      lastDiagnosticAt: null,
      lastError: null,
      lastRefreshedAt: null,
      logistics: null,
      status: "DISCONNECTED",
      userIdMasked: null,
      warehouse: null,
    };
  }

  return {
    authorizedAt: row.authorizedAt,
    authorizedByAdminUserId: row.authorizedByAdminUserId,
    fulfillmentEnabled: row.status === "ENABLED",
    fulfillmentEnabledAt: row.fulfillmentEnabledAt,
    lastDiagnosticAt: row.lastDiagnosticAt,
    lastError:
      row.lastErrorCode && row.lastErrorSummary
        ? {
            code: safeErrorCode(row.lastErrorCode),
            summary: "极风连接需要处理，请根据错误分类重新检查配置",
          }
        : null,
    lastRefreshedAt: row.lastRefreshedAt,
    logistics:
      row.logisticsId === null
        ? null
        : { id: row.logisticsId, name: row.logisticsName },
    status: row.status,
    userIdMasked: maskIdentifier(row.userId),
    warehouse:
      row.warehouseCode === null
        ? null
        : { code: row.warehouseCode, name: row.warehouseName },
  };
}

export async function getJifengConnectionPublicStatus(): Promise<JifengConnectionPublicStatus> {
  const view = await getJifengConnectionAdminView();
  return {
    connected: view.status !== "DISCONNECTED" && view.status !== "ERROR",
    fulfillmentEnabled: view.status === "ENABLED",
    lastDiagnosticAt: view.lastDiagnosticAt,
    status: view.status,
  };
}
