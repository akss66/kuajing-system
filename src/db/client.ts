import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const databaseClient = postgres(connectionString, {
  idle_timeout: 1,
  max: 10,
});

export const db = drizzle({ client: databaseClient });
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const withTransaction = db.transaction.bind(db);
