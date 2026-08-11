import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const webhookDataSchema = z
  .object({
    erpNo: z.string().min(1),
    status: z.string().min(1),
    userId: z.coerce.string().min(1),
    warehouseCode: z.string().optional(),
  })
  .passthrough();

const webhookBodySchema = z.object({
  data: z.unknown(),
  timestamp: z.coerce.number().int().positive(),
  type: z.literal("order"),
});

export class JifengWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JifengWebhookError";
  }
}

export function signJifengWebhookData(data: unknown, clientSecret: string) {
  return createHash("md5")
    .update(JSON.stringify(data), "utf8")
    .update(clientSecret, "utf8")
    .digest("hex");
}

export function parseAndVerifyJifengWebhook(input: {
  body: unknown;
  clientSecret: string;
  expectedUserId: string;
  now?: Date;
  signature: string | null | undefined;
}) {
  const parsed = webhookBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw new JifengWebhookError("极风 Webhook 请求格式无效");
  }
  const parsedData = webhookDataSchema.safeParse(parsed.data.data);
  if (!parsedData.success) {
    throw new JifengWebhookError("极风 Webhook 请求格式无效");
  }
  if (!input.signature || !/^[0-9a-f]{32}$/i.test(input.signature)) {
    throw new JifengWebhookError("极风 Webhook 签名缺失或格式无效");
  }
  const expected = signJifengWebhookData(parsed.data.data, input.clientSecret);
  const receivedBuffer = Buffer.from(input.signature.toLowerCase(), "ascii");
  const expectedBuffer = Buffer.from(expected, "ascii");
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new JifengWebhookError("极风 Webhook 签名验证失败");
  }
  if (parsedData.data.userId !== input.expectedUserId) {
    throw new JifengWebhookError("极风 Webhook 用户不匹配");
  }
  const now = input.now ?? new Date();
  if (Math.abs(now.getTime() - parsed.data.timestamp) > 5 * 60_000) {
    throw new JifengWebhookError("极风 Webhook 时间戳已过期");
  }
  return { ...parsed.data, data: parsedData.data };
}
