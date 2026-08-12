import { describe, expect, test, vi } from "vitest";

import {
  assertAllowedE2ETestDatabaseName,
  describeDatabaseTarget,
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

  test("uses the explicit local default test database when TEST_DATABASE_URL is missing", () => {
    const resolved = resolveE2ETestDatabaseUrl({
      DATABASE_URL: "postgres://prod-user:prod-pass@db.example.com:5432/tongzhouxing",
    });

    expect(resolved).toBe("postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test");
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
});
