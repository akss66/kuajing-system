import { NextResponse } from "next/server";

import { JifengClient } from "@/integrations/jifeng/client";
import { readJifengConfig } from "@/integrations/jifeng/config";
import {
  JifengWebhookError,
  parseAndVerifyJifengWebhook,
} from "@/integrations/jifeng/webhook";
import { applyJifengOrderStatus } from "@/modules/fulfillment/status-sync";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const config = readJifengConfig();
    const bodySignature =
      typeof body === "object" && body !== null && "sign" in body
        ? String(body.sign)
        : null;
    const webhook = parseAndVerifyJifengWebhook({
      body,
      clientSecret: config.clientSecret,
      expectedUserId: config.userId,
      signature: request.headers.get("x-jifeng-signature") ?? bodySignature,
    });
    const client = new JifengClient({ credentials: config });
    const detail = await client.getOrder({ erpNo: webhook.data.erpNo });
    await applyJifengOrderStatus({ detail, source: "WEBHOOK" });
    return NextResponse.json({ code: 0, msg: "" });
  } catch (error) {
    if (error instanceof JifengWebhookError) {
      return NextResponse.json(
        { code: 401, msg: "Webhook verification failed" },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { code: 503, msg: "Webhook processing unavailable" },
      { status: 503 },
    );
  }
}
