import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { jifengConnections } from "@/db/schema";
import { JifengClient } from "@/integrations/jifeng/client";
import {
  JifengConfigError,
  readJifengAuthorizedConfig,
  readJifengConfig,
} from "@/integrations/jifeng/config";
import type { JifengCredentials } from "@/integrations/jifeng/types";
import {
  enqueuePaidOrdersForFulfillment,
  processDueJifengCreateOrderEvents,
  type DispatchConfig,
} from "@/modules/fulfillment/dispatch";
import { pollActiveJifengFulfillments } from "@/modules/fulfillment/status-sync";

import {
  getPersistedJifengRuntime,
  JifengConnectionError,
} from "./service";

const PRIMARY_CONNECTION_KEY = "PRIMARY";

export class JifengProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JifengProviderError";
  }
}

export type JifengReadRuntime = {
  client: JifengClient;
};

export type JifengWriteRuntime = JifengReadRuntime & {
  config: DispatchConfig;
};

export type JifengCycleSummary = {
  enabled: boolean;
  enqueuedCount: number;
  processed: {
    completed: number;
    failed: number;
    retryScheduled: number;
  };
  statuses: {
    exceptions: number;
    pollFailures: number;
    shipped: number;
    synced: number;
  };
};

const noProcessedEvents = () => ({ completed: 0, failed: 0, retryScheduled: 0 });
const noStatusUpdates = () => ({
  exceptions: 0,
  pollFailures: 0,
  shipped: 0,
  synced: 0,
});

function providerError(code: string, message: string): never {
  throw new JifengProviderError(code, message);
}

type AuthenticationRejectedCallback = () => void | Promise<void>;

function buildReadRuntime(
  credentials: JifengCredentials,
  onAuthenticationRejected?: AuthenticationRejectedCallback,
): JifengReadRuntime {
  return {
    client: new JifengClient({
      automaticRefresh: onAuthenticationRejected ? false : undefined,
      credentials,
      onAuthenticationRejected,
    }),
  };
}

function buildWriteRuntime(
  credentials: JifengCredentials & {
    logisticsId: number | null;
    warehouseCode: string | null;
  },
  onAuthenticationRejected?: AuthenticationRejectedCallback,
): JifengWriteRuntime {
  if (
    !Number.isSafeInteger(credentials.logisticsId) ||
    credentials.logisticsId === null ||
    credentials.logisticsId <= 0 ||
    !credentials.warehouseCode?.trim()
  ) {
    providerError(
      "RUNTIME_CONFIG_INVALID",
      "Jifeng runtime resources are not ready",
    );
  }

  return {
    client: new JifengClient({
      automaticRefresh: onAuthenticationRejected ? false : undefined,
      credentials,
      onAuthenticationRejected,
    }),
    config: {
      logisticsId: credentials.logisticsId,
      warehouseCode: credentials.warehouseCode,
    },
  };
}

async function readConnectionState() {
  const [row] = await db
    .select({
      logisticsId: jifengConnections.logisticsId,
      status: jifengConnections.status,
      warehouseCode: jifengConnections.warehouseCode,
    })
    .from(jifengConnections)
    .where(eq(jifengConnections.connectionKey, PRIMARY_CONNECTION_KEY))
    .limit(1);
  return row;
}

function readLegacyReadRuntime(): JifengReadRuntime {
  return buildReadRuntime(readJifengAuthorizedConfig());
}

function readLegacyWriteRuntime(): JifengWriteRuntime {
  return buildWriteRuntime(readJifengConfig());
}

async function readStoredRuntimeSource(input: {
  requireFulfillmentEnabled: boolean;
}) {
  const before = await readConnectionState();
  if (!before) return null;

  if (input.requireFulfillmentEnabled && before.status !== "ENABLED") {
    providerError("FULFILLMENT_DISABLED", "Jifeng fulfillment is disabled");
  }

  const runtime = await getPersistedJifengRuntime();
  const after = await readConnectionState();
  if (!after) {
    providerError("CONNECTION_CHANGED", "Jifeng connection changed");
  }
  if (input.requireFulfillmentEnabled && after.status !== "ENABLED") {
    providerError("FULFILLMENT_DISABLED", "Jifeng fulfillment is disabled");
  }

  return {
    credentials: {
      ...runtime.credentials,
      logisticsId: after.logisticsId,
      warehouseCode: after.warehouseCode,
    },
    onAuthenticationRejected: runtime.onAuthenticationRejected,
  };
}

export async function getJifengReadClient(): Promise<JifengReadRuntime> {
  const stored = await readStoredRuntimeSource({
    requireFulfillmentEnabled: false,
  });
  return stored
    ? buildReadRuntime(stored.credentials, stored.onAuthenticationRejected)
    : readLegacyReadRuntime();
}

export async function getEnabledJifengWriteClient(): Promise<JifengWriteRuntime> {
  const stored = await readStoredRuntimeSource({
    requireFulfillmentEnabled: true,
  });
  if (stored) {
    return buildWriteRuntime(
      stored.credentials,
      stored.onAuthenticationRejected,
    );
  }

  if (process.env.JIFENG_LEGACY_FULFILLMENT_ENABLED !== "true") {
    providerError(
      "LEGACY_FULFILLMENT_DISABLED",
      "Legacy Jifeng fulfillment is disabled",
    );
  }
  return readLegacyWriteRuntime();
}

function isUnavailableConnection(error: unknown) {
  return (
    error instanceof JifengProviderError ||
    error instanceof JifengConnectionError ||
    error instanceof JifengConfigError
  );
}

async function pollWithReadClient() {
  try {
    const runtime = await getJifengReadClient();
    return await pollActiveJifengFulfillments({ client: runtime.client });
  } catch (error) {
    if (isUnavailableConnection(error)) return noStatusUpdates();
    throw error;
  }
}

export async function runJifengFulfillmentCycle(): Promise<JifengCycleSummary> {
  let runtime: JifengWriteRuntime;
  try {
    runtime = await getEnabledJifengWriteClient();
  } catch (error) {
    if (!isUnavailableConnection(error)) throw error;
    return {
      enabled: false,
      enqueuedCount: 0,
      processed: noProcessedEvents(),
      statuses: await pollWithReadClient(),
    };
  }

  const enqueuedCount = await enqueuePaidOrdersForFulfillment();
  const processed = await processDueJifengCreateOrderEvents(runtime);
  const statuses = await pollActiveJifengFulfillments({ client: runtime.client });
  return { enabled: true, enqueuedCount, processed, statuses };
}
