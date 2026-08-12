import { describe, expect, test } from "vitest";

import { buildSecurityHeaders } from "@/shared/security-headers";

describe("production security headers", () => {
  test("blocks framing, MIME sniffing and risky browser capabilities", () => {
    const headers = Object.fromEntries(
      buildSecurityHeaders({ production: true }).map((header) => [header.key, header.value]),
    );

    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-eval");
  });

  test("allows the Next development evaluator without enabling HSTS locally", () => {
    const headers = Object.fromEntries(
      buildSecurityHeaders({ production: false }).map((header) => [header.key, header.value]),
    );

    expect(headers["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });
});
