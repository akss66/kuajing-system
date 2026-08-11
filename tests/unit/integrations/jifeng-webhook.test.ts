import { describe, expect, test } from "vitest";

import {
  JifengWebhookError,
  parseAndVerifyJifengWebhook,
  signJifengWebhookData,
} from "@/integrations/jifeng/webhook";

const data = {
  erpNo: "TZX-WEBHOOK-1",
  skuList: [{ num: 1, sku: "TZX-001" }],
  status: "Shipped",
  userId: "8",
  warehouseCode: "CA-YYZ",
};

describe("Jifeng webhook verification", () => {
  test("verifies the documented MD5 data signature and expected user", () => {
    const secret = "test-client-secret";
    const timestamp = Date.parse("2026-08-12T04:00:00.000Z");
    const signature = signJifengWebhookData(data, secret);

    expect(
      parseAndVerifyJifengWebhook({
        body: { data, timestamp, type: "order" },
        clientSecret: secret,
        expectedUserId: "8",
        now: new Date(timestamp + 60_000),
        signature,
      }),
    ).toMatchObject({ data: { erpNo: data.erpNo, userId: "8" }, type: "order" });
  });

  test("rejects bad signatures, unexpected users and stale callbacks", () => {
    const secret = "test-client-secret";
    const timestamp = Date.parse("2026-08-12T04:00:00.000Z");
    const signature = signJifengWebhookData(data, secret);

    expect(() =>
      parseAndVerifyJifengWebhook({
        body: { data, timestamp, type: "order" },
        clientSecret: secret,
        expectedUserId: "8",
        now: new Date(timestamp),
        signature: "0".repeat(32),
      }),
    ).toThrowError(JifengWebhookError);
    expect(() =>
      parseAndVerifyJifengWebhook({
        body: { data: { ...data, userId: "9" }, timestamp, type: "order" },
        clientSecret: secret,
        expectedUserId: "8",
        now: new Date(timestamp),
        signature: signJifengWebhookData({ ...data, userId: "9" }, secret),
      }),
    ).toThrow("极风 Webhook 用户不匹配");
    expect(() =>
      parseAndVerifyJifengWebhook({
        body: { data, timestamp, type: "order" },
        clientSecret: secret,
        expectedUserId: "8",
        now: new Date(timestamp + 6 * 60_000),
        signature,
      }),
    ).toThrow("极风 Webhook 时间戳已过期");
  });
});
