import { describe, expect, test } from "vitest";

import { configureIntegrationTestDatabaseEnvironment } from "../../../tests/integration/database-environment";

describe("integration test database environment", () => {
  test("ignores DATABASE_URL and derives an isolated loopback database", () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: "postgres://prod:secret@db.example.com:5432/shared_test",
    };

    const connectionString = configureIntegrationTestDatabaseEnvironment(
      env,
      "123_456",
    );

    expect(connectionString).toBe(
      "postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_integration_123_456_test",
    );
    expect(env.DATABASE_URL).toBe(connectionString);
    expect(env.TEST_DATABASE_URL).toBe(connectionString);
    expect(env.INTEGRATION_TEST_DATABASE_MANAGED).toBe("true");
  });

  test("rejects an explicit remote TEST_DATABASE_URL even when its name ends in test", () => {
    const env: Record<string, string | undefined> = {
      TEST_DATABASE_URL:
        "postgres://test-user:secret@db.example.com:5432/shared_test",
    };

    expect(() =>
      configureIntegrationTestDatabaseEnvironment(env, "123_456"),
    ).toThrow("must use local PostgreSQL");
  });

  test("rejects an existing loopback test database without destructive-reset opt-in", () => {
    const env: Record<string, string | undefined> = {
      TEST_DATABASE_URL:
        "postgres://test-user:secret@127.0.0.1:5432/shared_test",
    };

    expect(() =>
      configureIntegrationTestDatabaseEnvironment(env, "123_456"),
    ).toThrow("ALLOW_EXISTING_TEST_DB_RESET=true");
  });

  test.each(["127.0.0.1", "localhost", "::1"])(
    "accepts an explicitly opted-in isolated test database on %s",
    (host) => {
      const renderedHost = host.includes(":") ? `[${host}]` : host;
      const connectionString =
        `postgres://test-user:secret@${renderedHost}:5432/tongzhouxing_agent_test`;
      const env: Record<string, string | undefined> = {
        ALLOW_EXISTING_TEST_DB_RESET: "true",
        TEST_DATABASE_URL: connectionString,
      };

      expect(
        configureIntegrationTestDatabaseEnvironment(env, "123_456"),
      ).toBe(connectionString);
      expect(env.INTEGRATION_TEST_DATABASE_MANAGED).toBeUndefined();
    },
  );
});
