import { sql } from "drizzle-orm";

export const LOCAL_E2E_DATABASE_URL =
  "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test";
export const DEFAULT_E2E_PORT = "3101";

const E2E_RESET_TABLES = [
  "system_notifications",
  "integration_attempts",
  "integration_outbox",
  "replacement_requests",
  "shipment_fulfillments",
  "jifeng_authorization_attempts",
  "jifeng_connections",
  "audit_logs",
  "settlement_payment_claims",
  "settlement_batch_orders",
  "settlement_batches",
  "wallet_holds",
  "payment_claims",
  "wallet_transactions",
  "wallet_accounts",
  "order_lines",
  "order_shipments",
  "fulfillment_orders",
  "bulk_submission_requests",
  "bulk_import_store_groups",
  "bulk_import_drafts",
  "order_import_rows",
  "order_import_batches",
  "inventory_movements",
  "inventory_stocktake_batches",
  "feishu_cargo_migration_runs",
  "inventory_reservations",
  "inventory_balances",
  "sku_aliases",
  "customer_sku_prices",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
  "auth_users",
  "customer_users",
  "admin_users",
  "stores",
  "skus",
  "products",
  "customers",
];

type DatabaseExecutor = {
  execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
};

type EnvironmentSource = Record<string, string | undefined>;

export type DerivedE2EDatabaseProvisioner = {
  createDatabase: (databaseName: string) => Promise<void>;
  databaseExists: (databaseName: string) => Promise<boolean>;
  migrateDatabase: (connectionString: string) => Promise<void>;
};

function parseDatabaseUrl(connectionString: string) {
  return new URL(connectionString);
}

function extractDatabaseNameFromUrl(url: URL) {
  const pathname = decodeURIComponent(url.pathname);
  const segments = pathname.split("/").filter(Boolean);
  const databaseName = segments.at(-1);

  if (!databaseName) {
    throw new Error(`E2E database URL is missing a database name: ${describeDatabaseTarget(url.toString())}`);
  }

  return databaseName;
}

export function resolveE2EPort(rawPort: string | undefined) {
  const normalized = rawPort?.trim() || DEFAULT_E2E_PORT;
  if (!/^\d+$/.test(normalized)) {
    throw new Error("E2E_PORT must be an integer between 1 and 65535");
  }

  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_PORT must be an integer between 1 and 65535");
  }

  return normalized;
}

export function deriveLocalE2ETestDatabaseUrl(rawPort: string | undefined) {
  const port = resolveE2EPort(rawPort);
  const url = new URL(LOCAL_E2E_DATABASE_URL);
  url.pathname = `/tongzhouxing_e2e_${port}_test`;
  return url.toString();
}

export function isAllowedE2ETestDatabaseName(databaseName: string) {
  return databaseName === "tongzhouxing_test" || databaseName.endsWith("_test");
}

export function describeDatabaseTarget(connectionString: string) {
  const url = parseDatabaseUrl(connectionString);
  url.username = "";
  url.password = "";
  return url.toString();
}

export function assertAllowedE2ETestDatabaseName(connectionString: string, context: string) {
  const url = parseDatabaseUrl(connectionString);
  const databaseName = extractDatabaseNameFromUrl(url);

  if (!isAllowedE2ETestDatabaseName(databaseName)) {
    throw new Error(
      `${context} must target an allowed test database ending in "_test" (or exact "tongzhouxing_test"), received ${describeDatabaseTarget(connectionString)}`,
    );
  }

  return databaseName;
}

export function resolveE2ETestDatabaseUrl(env: EnvironmentSource) {
  const connectionString =
    env.TEST_DATABASE_URL?.trim() || deriveLocalE2ETestDatabaseUrl(env.E2E_PORT);

  assertAllowedE2ETestDatabaseName(connectionString, "Playwright E2E");
  return connectionString;
}

export function isDerivedLocalE2ETestDatabaseUrl(
  connectionString: string,
  rawPort: string | undefined,
) {
  return connectionString === deriveLocalE2ETestDatabaseUrl(rawPort);
}

export function configureE2ETestDatabaseEnvironment(env: EnvironmentSource = process.env) {
  const connectionString = resolveE2ETestDatabaseUrl(env);
  env.DATABASE_URL = connectionString;
  env.TEST_DATABASE_URL = connectionString;
  return connectionString;
}

export async function provisionDerivedE2ETestDatabase(input: {
  connectionString: string;
  provisioner: DerivedE2EDatabaseProvisioner;
}) {
  const databaseName = assertAllowedE2ETestDatabaseName(
    input.connectionString,
    "Playwright E2E provisioning",
  );
  if (!(await input.provisioner.databaseExists(databaseName))) {
    await input.provisioner.createDatabase(databaseName);
  }
  await input.provisioner.migrateDatabase(input.connectionString);
}

export async function assertCurrentE2ETestDatabase(database: DatabaseExecutor, context: string) {
  const result = (await database.execute(
    sql.raw("select current_database() as current_database"),
  )) as Array<{ current_database?: string }>;
  const databaseName = result[0]?.current_database;

  if (!databaseName) {
    throw new Error(`${context} could not determine current_database() before running a destructive reset`);
  }

  if (!isAllowedE2ETestDatabaseName(databaseName)) {
    throw new Error(
      `${context} refused to run against current_database()="${databaseName}". E2E destructive resets require a database ending in "_test" (or exact "tongzhouxing_test").`,
    );
  }

  return databaseName;
}

export async function resetE2EDatabaseToSeedState(input: {
  context: string;
  database: DatabaseExecutor;
  reseed: () => Promise<unknown>;
}) {
  await assertCurrentE2ETestDatabase(input.database, input.context);
  await input.database.execute(
    sql.raw(`
      truncate table
        ${E2E_RESET_TABLES.join(",\n        ")}
      restart identity cascade
    `),
  );
  await input.reseed();
}
