import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { assertAllowedE2ETestDatabaseName } from "../e2e/support/test-database";
import { isLocalIntegrationDatabaseUrl } from "./database-environment";

export default async function setupIntegrationDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is required for integration tests");
  }
  const databaseName = assertAllowedE2ETestDatabaseName(
    connectionString,
    "Vitest integration database",
  );
  const managed = process.env.INTEGRATION_TEST_DATABASE_MANAGED === "true";
  if (!isLocalIntegrationDatabaseUrl(connectionString)) {
    throw new Error("Integration databases must use local PostgreSQL");
  }

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { idle_timeout: 1, max: 1 });
  try {
    const rows = await admin<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${databaseName}) as exists
    `;
    if (!rows[0]?.exists) {
      if (!managed) {
        throw new Error(`Explicit integration database does not exist: ${databaseName}`);
      }
      await admin.unsafe(`create database "${databaseName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const target = postgres(connectionString, { idle_timeout: 1, max: 1 });
  try {
    const currentRows = await target<{ currentDatabase: string }[]>`
      select current_database() as "currentDatabase"
    `;
    if (currentRows[0]?.currentDatabase !== databaseName) {
      throw new Error("Integration database identity changed before migration");
    }
    await migrate(drizzle({ client: target }), { migrationsFolder: "drizzle" });
  } finally {
    await target.end({ timeout: 5 });
  }

  if (!managed) return;
  return async () => {
    const cleanupAdmin = postgres(adminUrl.toString(), { idle_timeout: 1, max: 1 });
    try {
      await cleanupAdmin.unsafe(`drop database if exists "${databaseName}" with (force)`);
    } finally {
      await cleanupAdmin.end({ timeout: 5 });
    }
  };
}
