import { describe, expect, test } from "vitest";

import {
  inspectJifengConfiguration,
  JifengConfigError,
  readJifengAuthorizedConfig,
  readJifengConfig,
  readJifengDeveloperConfig,
} from "@/integrations/jifeng/config";

describe("Jifeng configuration", () => {
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

  test("inspects the configuration layers without requiring warehouse parameters for read-only probes", () => {
    const state = inspectJifengConfiguration({
      JIFENG_ACCESS_TOKEN: "access-token",
      JIFENG_BASE_URL: "https://warehouse.example.test",
      JIFENG_CLIENT_ID: "developer-id",
      JIFENG_CLIENT_SECRET: "developer-secret",
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
  });
});
