import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  isDerivedLocalE2ETestDatabaseUrl,
  provisionDerivedE2ETestDatabase,
} from "../tests/e2e/support/test-database";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("TEST_DATABASE_URL is required before E2E database preparation");
}
if (!isDerivedLocalE2ETestDatabaseUrl(connectionString, process.env.E2E_PORT)) {
  throw new Error("E2E database preparation refuses to provision a non-derived database target");
}

const targetUrl = new URL(connectionString);
const adminUrl = new URL(connectionString);
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { idle_timeout: 1, max: 1 });

try {
  await provisionDerivedE2ETestDatabase({
    connectionString,
    provisioner: {
      databaseExists: async (databaseName) => {
        const rows = await admin<{ exists: boolean }[]>`
          select exists(select 1 from pg_database where datname = ${databaseName}) as exists
        `;
        return rows[0]?.exists === true;
      },
      createDatabase: async (databaseName) => {
        await admin.unsafe(`create database "${databaseName}"`);
      },
      migrateDatabase: async (targetConnectionString) => {
        const client = postgres(targetConnectionString, { idle_timeout: 1, max: 1 });
        try {
          await migrate(drizzle({ client }), { migrationsFolder: "drizzle" });
        } finally {
          await client.end({ timeout: 5 });
        }
      },
    },
  });
} finally {
  await admin.end({ timeout: 5 });
}

console.log(`E2E database ready: ${targetUrl.pathname.slice(1)}`);
