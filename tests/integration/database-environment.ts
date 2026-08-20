import { assertAllowedE2ETestDatabaseName } from "../e2e/support/test-database.js";

const LOCAL_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOCAL_INTEGRATION_DATABASE_URL =
  "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test";

type EnvironmentSource = Record<string, string | undefined>;

export function isLocalIntegrationDatabaseUrl(connectionString: string) {
  const hostname = new URL(connectionString).hostname.replace(/^\[|\]$/g, "");
  return LOCAL_DATABASE_HOSTS.has(hostname);
}

export function configureIntegrationTestDatabaseEnvironment(
  env: EnvironmentSource = process.env,
  uniqueSuffix = `${process.pid}_${Date.now()}`,
) {
  const explicitTestDatabaseUrl = env.TEST_DATABASE_URL?.trim();
  let connectionString: string;

  if (explicitTestDatabaseUrl) {
    assertAllowedE2ETestDatabaseName(
      explicitTestDatabaseUrl,
      "Vitest integration database",
    );
    if (!isLocalIntegrationDatabaseUrl(explicitTestDatabaseUrl)) {
      throw new Error(
        "Vitest integration database must use local PostgreSQL; remote and shared databases are refused",
      );
    }
    if (env.ALLOW_EXISTING_TEST_DB_RESET !== "true") {
      throw new Error(
        "Reusing an existing integration database requires ALLOW_EXISTING_TEST_DB_RESET=true because the suite migrates and truncates it",
      );
    }
    connectionString = explicitTestDatabaseUrl;
    delete env.INTEGRATION_TEST_DATABASE_MANAGED;
  } else {
    const databaseUrl = new URL(LOCAL_INTEGRATION_DATABASE_URL);
    databaseUrl.pathname = `/tongzhouxing_integration_${uniqueSuffix}_test`;
    connectionString = databaseUrl.toString();
    env.INTEGRATION_TEST_DATABASE_MANAGED = "true";
  }

  env.DATABASE_URL = connectionString;
  env.TEST_DATABASE_URL = connectionString;
  return connectionString;
}
