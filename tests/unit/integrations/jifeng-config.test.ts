import { describe, expect, test } from "vitest";

import {
  inspectJifengConfiguration,
  JifengConfigError,
  readJifengAuthorizedConfig,
  readJifengConfig,
  readJifengDeveloperConfig,
} from "@/integrations/jifeng/config";

describe("Jifeng configuration", () => {
  test("does not report OAuth developer readiness before every server secret is valid", () => {
    const incomplete = inspectJifengConfiguration({
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
    });

    expect(incomplete.developer).toMatchObject({
      configured: false,
      missingFields: [
        "JIFENG_BASE_URL",
        "JIFENG_DOMAIN",
        "JIFENG_TOKEN_ENCRYPTION_KEY",
      ],
    });

    const ready = inspectJifengConfiguration({
      JIFENG_BASE_URL: "https://api.example.test",
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
      JIFENG_DOMAIN: "tenant-a",
      JIFENG_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    });
    expect(ready.developer).toMatchObject({ configured: true });
    expect(ready.level).toBe("DEVELOPER_ONLY");
  });

  test("maps developer credentials, authorized access, and fulfillment fields without inventing extra inputs", () => {
    const environment = {
      JIFENG_ACCESS_TOKEN: "access-token",
      JIFENG_BASE_URL: "https://api.example.test/",
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
      JIFENG_LOGISTICS_ID: "42",
      JIFENG_REFRESH_TOKEN: "refresh-token",
      JIFENG_USER_ID: "oms-user-7",
      JIFENG_WAREHOUSE_CODE: "CA-YYZ",
    };

    expect(readJifengDeveloperConfig(environment)).toEqual({
      clientId: "developer-id",
      clientSecret: "developer-secret",
    });
    expect(readJifengAuthorizedConfig(environment)).toEqual({
      accessToken: "access-token",
      baseUrl: "https://api.example.test",
      clientId: "developer-id",
      clientSecret: "developer-secret",
      refreshToken: "refresh-token",
      userId: "oms-user-7",
    });
    expect(readJifengConfig(environment)).toEqual({
      accessToken: "access-token",
      baseUrl: "https://api.example.test",
      clientId: "developer-id",
      clientSecret: "developer-secret",
      logisticsId: 42,
      refreshToken: "refresh-token",
      userId: "oms-user-7",
      warehouseCode: "CA-YYZ",
    });
  });

  test("reports sanitized missing authorized fields without echoing values", () => {
    expect(() =>
      readJifengAuthorizedConfig({
        JIFENG_CLIENT_ID: "developer-id",
        JIFENG_CLIENT_SECRET: "developer-secret",
      }),
    ).toThrowError(JifengConfigError);

    const error = (() => {
      try {
        readJifengAuthorizedConfig({
          JIFENG_CLIENT_ID: "developer-id",
          JIFENG_CLIENT_SECRET: "developer-secret",
        });
      } catch (cause) {
        return cause;
      }
      throw new Error("expected config error");
    })();

    expect(error).toBeInstanceOf(JifengConfigError);
    expect(error).toMatchObject({
      invalidFields: [],
      missingFields: [
        "JIFENG_ACCESS_TOKEN",
        "JIFENG_BASE_URL",
        "JIFENG_USER_ID",
      ],
    });
    expect((error as Error).message).toContain("JIFENG_ACCESS_TOKEN");
    expect((error as Error).message).not.toContain("developer-secret");
  });

  test("rejects a production-only base URL override", () => {
    const baseUrlOverride = "https://warehouse-b.example.test";
    const error = (() => {
      try {
        readJifengAuthorizedConfig(
          {
            JIFENG_ACCESS_TOKEN: "access-token",
            JIFENG_BASE_URL: "https://warehouse-a.example.test",
            JIFENG_CLIENT_ID: "developer-id",
            JIFENG_CLIENT_SECRET: "developer-secret",
            JIFENG_USER_ID: "oms-user-7",
          },
          { baseUrlOverride, nodeEnv: "production" },
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("expected config error");
    })();

    expect(error).toBeInstanceOf(JifengConfigError);
    expect((error as Error).message).toMatch(/override/i);
    expect((error as Error).message).not.toContain(baseUrlOverride);
  });

  test("accepts an HTTPS origin with an explicit port in production", () => {
    const config = readJifengAuthorizedConfig({
      JIFENG_ACCESS_TOKEN: "access-token",
      JIFENG_BASE_URL: "https://api.example.test:8443/",
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
      JIFENG_USER_ID: "oms-user-7",
      NODE_ENV: "production",
    });

    expect(config.baseUrl).toBe("https://api.example.test:8443");
  });

  test.each([
    "http://api.example.test",
    "https://api.example.test/proxy",
    "https://api.example.test?tenant=secret",
    "https://api.example.test#fragment-secret",
    "https://operator:password@api.example.test",
  ])("rejects a non-origin production base URL without echoing it: %s", (baseUrl) => {
    const error = (() => {
      try {
        readJifengAuthorizedConfig({
          JIFENG_ACCESS_TOKEN: "access-token",
          JIFENG_BASE_URL: baseUrl,
          JIFENG_CLIENT_ID: "developer-id",
          JIFENG_CLIENT_SECRET: "developer-secret",
          JIFENG_USER_ID: "oms-user-7",
          NODE_ENV: "production",
        });
      } catch (cause) {
        return cause;
      }
      throw new Error("expected config error");
    })();

    expect(error).toBeInstanceOf(JifengConfigError);
    expect(error).toMatchObject({
      invalidFields: ["JIFENG_BASE_URL"],
      missingFields: [],
    });
    expect((error as Error).message).not.toContain(baseUrl);
  });

  test.each([
    "http://127.0.0.1:15489/",
    "http://localhost:15489/",
    "http://[::1]:15489/",
  ])("accepts an explicit loopback HTTP origin outside production: %s", (baseUrl) => {
    const config = readJifengAuthorizedConfig({
      JIFENG_ACCESS_TOKEN: "access-token",
      JIFENG_BASE_URL: baseUrl,
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
      JIFENG_USER_ID: "oms-user-7",
      NODE_ENV: "test",
    });

    expect(config.baseUrl).toBe(new URL(baseUrl).origin);
  });

  test("rejects remote HTTP outside production without echoing the URL", () => {
    const baseUrl = "http://remote.example.test:8080";
    const error = (() => {
      try {
        readJifengAuthorizedConfig({
          JIFENG_ACCESS_TOKEN: "access-token",
          JIFENG_BASE_URL: baseUrl,
          JIFENG_CLIENT_ID: "developer-id",
          JIFENG_CLIENT_SECRET: "developer-secret",
          JIFENG_USER_ID: "oms-user-7",
          NODE_ENV: "test",
        });
      } catch (cause) {
        return cause;
      }
      throw new Error("expected config error");
    })();

    expect(error).toBeInstanceOf(JifengConfigError);
    expect(error).toMatchObject({ invalidFields: ["JIFENG_BASE_URL"] });
    expect((error as Error).message).not.toContain(baseUrl);
  });

  test("inspects the configuration layers without requiring warehouse parameters for read-only probes", () => {
    const state = inspectJifengConfiguration({
      JIFENG_ACCESS_TOKEN: "access-token",
      JIFENG_BASE_URL: "https://warehouse.example.test",
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
      JIFENG_DOMAIN: "tenant-a",
      JIFENG_REFRESH_TOKEN: "refresh-token",
      JIFENG_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url"),
      JIFENG_USER_ID: "oms-user-7",
    });

    expect(state.level).toBe("AUTHORIZED_ONLY");
    expect(state.developer.configured).toBe(true);
    expect(state.authorized.configured).toBe(true);
    expect(state.fulfillment.configured).toBe(false);
    expect(state.fulfillment.missingFields).toEqual([
      "JIFENG_LOGISTICS_ID",
      "JIFENG_WAREHOUSE_CODE",
    ]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refresh-token");
    expect(serialized).not.toContain("developer-secret");
  });
});
