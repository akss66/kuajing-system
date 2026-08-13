import { describe, expect, test, vi } from "vitest";

import { JifengApiError } from "@/integrations/jifeng/client";
import { runJifengConnectivityDiagnostic } from "@/integrations/jifeng/diagnostics";

describe("Jifeng connectivity diagnostics", () => {
  test("falls back to a local signing self-check when OAuth outputs are missing", async () => {
    const result = await runJifengConnectivityDiagnostic({
      environment: {
        JIFENG_CLIENT_ID: "developer-id",
        JIFENG_CLIENT_SECRET: "developer-secret",
      },
    });

    expect(result.status).toBe("LOCAL_ONLY");
    expect(result.configurationLevel).toBe("DEVELOPER_ONLY");
    expect(result.localSelfCheck).toEqual({
      ok: true,
      source:
        "https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce/doc-3651609.md",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("canonicalString");
    expect(serialized).not.toContain("expectedCanonicalString");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("expectedSignature");
    expect(serialized).not.toContain("accessToken=");
    expect(serialized).not.toContain("9bc08ba7552c5dfea4efab6bda78a4a9738010913f2403bd93f09c6bf974b939");
    expect(result.remoteProbe).toEqual({
      attempted: false,
      missingFields: [
        "JIFENG_ACCESS_TOKEN",
        "JIFENG_BASE_URL",
        "JIFENG_USER_ID",
      ],
      outcome: "MISSING_AUTHORIZED_FIELDS",
    });
  });

  test("uses the documented order query as a read-only remote probe", async () => {
    const getOrder = vi.fn(async () => {
      throw new JifengApiError({
        code: "50017",
        message: "The order was not found in the warehouse!",
        retryable: false,
      });
    });

    const result = await runJifengConnectivityDiagnostic({
      client: { getOrder },
      environment: {
        JIFENG_ACCESS_TOKEN: "access-token",
        JIFENG_BASE_URL: "https://warehouse.example.test",
        JIFENG_CLIENT_ID: "developer-id",
        JIFENG_CLIENT_SECRET: "developer-secret",
        JIFENG_USER_ID: "oms-user-7",
      },
      now: new Date("2026-08-13T06:00:00.000Z"),
      probeErpNo: "TZX-JF-CONNECTIVITY-TEST",
    });

    expect(result.status).toBe("REMOTE_OK");
    expect(result.configurationLevel).toBe("AUTHORIZED_ONLY");
    expect(result.remoteProbe).toMatchObject({
      attempted: true,
      code: "50017",
      outcome: "ORDER_NOT_FOUND_CONFIRMED",
      probeErpNo: "TZX-JF-CONNECTIVITY-TEST",
    });
    expect(getOrder).toHaveBeenCalledWith({ erpNo: "TZX-JF-CONNECTIVITY-TEST" });
  });

  test("surfaces sanitized remote failures without exposing tokens", async () => {
    const getOrder = vi.fn(async () => {
      throw new JifengApiError({
        code: "10026",
        message: "SIGN error accessToken=secret-token",
        retryable: false,
      });
    });

    const result = await runJifengConnectivityDiagnostic({
      client: { getOrder },
      environment: {
        JIFENG_ACCESS_TOKEN: "secret-token",
        JIFENG_BASE_URL: "https://warehouse.example.test",
        JIFENG_CLIENT_ID: "developer-id",
        JIFENG_CLIENT_SECRET: "developer-secret",
        JIFENG_USER_ID: "oms-user-7",
      },
    });

    expect(result.status).toBe("REMOTE_FAILED");
    expect(result.remoteProbe).toMatchObject({
      attempted: true,
      code: "10026",
      outcome: "AUTHENTICATION_REJECTED",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(getOrder).toHaveBeenCalledTimes(1);
  });
});
