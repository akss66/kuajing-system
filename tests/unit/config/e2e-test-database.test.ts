import { describe, expect, test, vi } from "vitest";

import {
  assertAllowedE2ETestDatabaseName,
  describeDatabaseTarget,
  isDerivedLocalE2ETestDatabaseUrl,
  provisionDerivedE2ETestDatabase,
  resetE2EDatabaseToSeedState,
  resolveE2ETestDatabaseUrl,
} from "../../e2e/support/test-database";

describe("resolveE2ETestDatabaseUrl", () => {
  test("prefers TEST_DATABASE_URL over a caller DATABASE_URL", () => {
    const resolved = resolveE2ETestDatabaseUrl({
      DATABASE_URL: "postgres://prod-user:prod-pass@db.example.com:5432/tongzhouxing",
      TEST_DATABASE_URL: "postgres://test-user:test-pass@127.0.0.1:5432/tongzhouxing_test",
    });

    expect(resolved).toBe("postgres://test-user:test-pass@127.0.0.1:5432/tongzhouxing_test");
  });

  test("derives an isolated local test database from the validated E2E port when TEST_DATABASE_URL is missing", () => {
    const resolved = resolveE2ETestDatabaseUrl({
      DATABASE_URL: "postgres://prod-user:prod-pass@db.example.com:5432/tongzhouxing",
      E2E_PORT: "3101",
    });

    expect(resolved).toBe(
      "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_e2e_3101_test",
    );
  });

  test("assigns different default databases to different worktree ports", () => {
    expect(resolveE2ETestDatabaseUrl({ E2E_PORT: "3101" })).not.toBe(
      resolveE2ETestDatabaseUrl({ E2E_PORT: "3107" }),
    );
  });

  test("rejects an unsafe E2E port instead of interpolating it into a database name", () => {
    expect(() =>
      resolveE2ETestDatabaseUrl({ E2E_PORT: '3101_test; drop database "postgres"' }),
    ).toThrowError(/E2E_PORT must be an integer between 1 and 65535/);
  });

  test("only classifies the exact derived local target as harness-provisioned", () => {
    expect(
      isDerivedLocalE2ETestDatabaseUrl(
        "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_e2e_3101_test",
        "3101",
      ),
    ).toBe(true);
    expect(
      isDerivedLocalE2ETestDatabaseUrl(
        "postgres://tongzhouxing:tongzhouxing@localhost:5432/tongzhouxing_e2e_3101_test",
        "3101",
      ),
    ).toBe(false);
  });

  test("rejects a resolved database name that does not follow the strict test-db rule", () => {
    expect(() =>
      resolveE2ETestDatabaseUrl({
        TEST_DATABASE_URL: "postgres://user:secret@127.0.0.1:5432/tongzhouxing",
      }),
    ).toThrowError(/must target an allowed test database/i);
  });
});

describe("assertAllowedE2ETestDatabaseName", () => {
  test("accepts encoded pathnames and query strings when the database basename is a real test database", () => {
    expect(() =>
      assertAllowedE2ETestDatabaseName(
        "postgres://user:secret@127.0.0.1:5432/tongzhouxing_test?sslmode=disable",
        "unit-test",
      ),
    ).not.toThrow();
  });

  test("does not leak credentials in rejection messages", () => {
    expect(() =>
      assertAllowedE2ETestDatabaseName(
        "postgres://prod-user:prod-pass@contest-db.example.com:5432/orders",
        "unit-test",
      ),
    ).toThrowError(/postgres:\/\/contest-db\.example\.com:5432\/orders/);
  });

  test("describes the sanitized target without credentials", () => {
    expect(describeDatabaseTarget("postgres://alice:secret@127.0.0.1:5432/tongzhouxing_test?sslmode=disable")).toBe(
      "postgres://127.0.0.1:5432/tongzhouxing_test?sslmode=disable",
    );
  });
});

describe("provisionDerivedE2ETestDatabase", () => {
  test("creates a missing derived database and migrates it before Playwright starts", async () => {
    const operations: string[] = [];
    const provisioner = {
      databaseExists: async (databaseName: string) => {
        operations.push(`exists:${databaseName}`);
        return false;
      },
      createDatabase: async (databaseName: string) => {
        operations.push(`create:${databaseName}`);
      },
      migrateDatabase: async (connectionString: string) => {
        operations.push(`migrate:${new URL(connectionString).pathname}`);
      },
    };

    await provisionDerivedE2ETestDatabase({
      connectionString:
        "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_e2e_3101_test",
      provisioner,
    });

    expect(operations).toEqual([
      "exists:tongzhouxing_e2e_3101_test",
      "create:tongzhouxing_e2e_3101_test",
      "migrate:/tongzhouxing_e2e_3101_test",
    ]);
  });

  test("migrates an existing derived database without attempting to recreate it", async () => {
    const createDatabase = vi.fn(async () => undefined);
    const migrateDatabase = vi.fn(async () => undefined);

    await provisionDerivedE2ETestDatabase({
      connectionString:
        "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_e2e_3101_test",
      provisioner: {
        databaseExists: async () => true,
        createDatabase,
        migrateDatabase,
      },
    });

    expect(createDatabase).not.toHaveBeenCalled();
    expect(migrateDatabase).toHaveBeenCalledOnce();
  });
});

describe("resetE2EDatabaseToSeedState", () => {
  test("refuses destructive resets when current_database() is not an allowed test database", async () => {
    const execute = vi.fn(async () => [{ current_database: "tongzhouxing" }]);
    const reseed = vi.fn(async () => undefined);

    await expect(
      resetE2EDatabaseToSeedState({
        context: "unit-test",
        database: { execute },
        reseed,
      }),
    ).rejects.toThrowError(/refused to run against current_database\(\)="tongzhouxing"/i);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(reseed).not.toHaveBeenCalled();
  });

  test("resets every parent table used by repeatable inventory E2E fixtures", async () => {
    const execute = vi.fn(async (query: unknown) => {
      if (execute.mock.calls.length === 1) {
        return [{ current_database: "tongzhouxing_e2e_fixture_test" }];
      }
      const serialized = JSON.stringify(query);
      expect(serialized).toContain("feishu_cargo_migration_runs");
      expect(serialized).toContain("inventory_stocktake_batches");
      return [];
    });
    const reseed = vi.fn(async () => undefined);

    await resetE2EDatabaseToSeedState({
      context: "repeatable fixture test",
      database: { execute },
      reseed,
    });

    expect(reseed).toHaveBeenCalledOnce();
  });
});
