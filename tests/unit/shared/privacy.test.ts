import { describe, expect, test } from "vitest";

import {
  maskAddress,
  maskEmail,
  maskName,
  maskPhone,
  maskWechat,
  redactSensitiveText,
  sanitizeForLog,
} from "@/shared/privacy";

describe("privacy masking", () => {
  test("masks direct identifiers while preserving enough context for support", () => {
    expect(maskName("张三")).toBe("张*");
    expect(maskName("Alice")).toBe("A****");
    expect(maskPhone("+1 613 555 0120")).toBe("***********0120");
    expect(maskEmail("owner@example.com")).toBe("o***@example.com");
    expect(maskAddress("400 Example Street, Ottawa")).toBe("400 Ex…");
    expect(maskWechat("wxid_customer_001")).toBe("wx***");
  });

  test("redacts credentials from messages and structured log metadata", () => {
    const text = redactSensitiveText(
      "request failed Authorization: Bearer abc.def clientSecret=my-secret&accessToken=token-1",
    );
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("my-secret");
    expect(text).not.toContain("token-1");
    expect(
      sanitizeForLog({
        code: "HTTP_500",
        nested: { recipientPhone: "+1 613 555 0120" },
        requestId: "safe-request-id",
        token: "secret-token",
      }),
    ).toEqual({
      code: "HTTP_500",
      nested: { recipientPhone: "[REDACTED]" },
      requestId: "safe-request-id",
      token: "[REDACTED]",
    });
  });
});
