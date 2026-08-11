import { PgBoss } from "pg-boss";

import { JifengClient } from "@/integrations/jifeng/client";
import { readJifengConfig } from "@/integrations/jifeng/config";
import {
  enqueuePaidOrdersForFulfillment,
  processDueJifengCreateOrderEvents,
} from "@/modules/fulfillment/dispatch";
import { expirePendingPaymentOrders } from "@/modules/orders/lifecycle";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const EXPIRE_PENDING_ORDERS_QUEUE = "expire-pending-payment-orders";
const JIFENG_FULFILLMENT_QUEUE = "jifeng-fulfillment-cycle";
const boss = new PgBoss(connectionString);

boss.on("error", (error) => {
  console.error("[worker] pg-boss error", error);
});

await boss.start();
await boss.createQueue(EXPIRE_PENDING_ORDERS_QUEUE);

// pg-boss 12.27: schedules are upserted by name and should use five-field cron
// expressions because the scheduler checks on a 30-second cadence.
// Source: https://pgboss.io/api/scheduling
await boss.schedule(EXPIRE_PENDING_ORDERS_QUEUE, "* * * * *", null, {
  tz: "UTC",
});

// pg-boss workers receive an array of jobs; batchSize 1 keeps this maintenance
// job single-purpose while database row locks make the domain operation idempotent.
// Source: https://pgboss.io/api/workers
await boss.work(EXPIRE_PENDING_ORDERS_QUEUE, { batchSize: 1 }, async () => {
  const expiredCount = await expirePendingPaymentOrders();
  console.info(`[worker] expired ${expiredCount} pending payment order(s)`);
  return { expiredCount };
});

const jifengRequiredVariables = [
  "JIFENG_ACCESS_TOKEN",
  "JIFENG_BASE_URL",
  "JIFENG_CLIENT_ID",
  "JIFENG_CLIENT_SECRET",
  "JIFENG_LOGISTICS_ID",
  "JIFENG_USER_ID",
  "JIFENG_WAREHOUSE_CODE",
] as const;
const configuredJifengVariables = jifengRequiredVariables.filter(
  (name) => Boolean(process.env[name]),
);
if (
  configuredJifengVariables.length > 0 &&
  configuredJifengVariables.length !== jifengRequiredVariables.length
) {
  throw new Error("极风集成仅配置了部分环境变量，请补齐后再启动任务进程");
}

if (configuredJifengVariables.length === jifengRequiredVariables.length) {
  const jifengConfig = readJifengConfig();
  const jifengClient = new JifengClient({ credentials: jifengConfig });
  await boss.createQueue(JIFENG_FULFILLMENT_QUEUE);
  await boss.schedule(JIFENG_FULFILLMENT_QUEUE, "* * * * *", null, {
    tz: "UTC",
  });
  await boss.work(JIFENG_FULFILLMENT_QUEUE, { batchSize: 1 }, async () => {
    const enqueuedCount = await enqueuePaidOrdersForFulfillment();
    const processed = await processDueJifengCreateOrderEvents({
      client: jifengClient,
      config: jifengConfig,
    });
    console.info(
      `[worker] Jifeng cycle enqueued=${enqueuedCount} completed=${processed.completed} retryScheduled=${processed.retryScheduled} failed=${processed.failed}`,
    );
    return { enqueuedCount, ...processed };
  });
  console.info("[worker] Jifeng fulfillment jobs enabled");
} else {
  console.info("[worker] Jifeng fulfillment jobs disabled: credentials not configured");
}

console.info("[worker] background jobs started");

let stopping = false;
async function stopWorker(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info(`[worker] received ${signal}, stopping`);
  await boss.stop({ close: true, graceful: true, timeout: 30_000 });
  process.exit(0);
}

process.once("SIGINT", () => void stopWorker("SIGINT"));
process.once("SIGTERM", () => void stopWorker("SIGTERM"));
