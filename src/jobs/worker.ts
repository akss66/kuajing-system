import { PgBoss } from "pg-boss";

import { FeishuClient } from "@/integrations/feishu/client";
import { readFeishuConfig } from "@/integrations/feishu/config";
import { runJifengFulfillmentCycle } from "@/modules/jifeng-connection/provider";
import {
  enqueueFeishuCargoSync,
  processFeishuOutbox,
} from "@/modules/feishu/outbox";
import { expirePendingPaymentOrders } from "@/modules/orders/lifecycle";
import { createDailyStockCoverageAlerts } from "@/modules/reports/stock-coverage";
import { expireSettlementBatches } from "@/modules/settlement/batch-service";
import { safeLogError } from "@/shared/privacy";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const EXPIRE_PENDING_ORDERS_QUEUE = "expire-pending-payment-orders";
const EXPIRE_SETTLEMENT_BATCHES_QUEUE = "expire-settlement-batches";
const JIFENG_FULFILLMENT_QUEUE = "jifeng-fulfillment-cycle";
const FEISHU_SYNC_QUEUE = "feishu-integration-cycle";
const STOCK_COVERAGE_ALERT_QUEUE = "daily-stock-coverage-alerts";
const boss = new PgBoss(connectionString);

boss.on("error", (error) => {
  console.error("[worker] pg-boss error", safeLogError(error));
});

await boss.start();
await boss.createQueue(EXPIRE_PENDING_ORDERS_QUEUE);
await boss.createQueue(EXPIRE_SETTLEMENT_BATCHES_QUEUE);

// pg-boss 12.27: schedules are upserted by name and should use five-field cron
// expressions because the scheduler checks on a 30-second cadence.
// Source: https://pgboss.io/api/scheduling
await boss.schedule(EXPIRE_PENDING_ORDERS_QUEUE, "* * * * *", null, {
  tz: "UTC",
});
await boss.schedule(EXPIRE_SETTLEMENT_BATCHES_QUEUE, "* * * * *", null, {
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
await boss.work(EXPIRE_SETTLEMENT_BATCHES_QUEUE, { batchSize: 1 }, async () => {
  const expiredCount = await expireSettlementBatches(new Date());
  console.info(`[worker] expired ${expiredCount} settlement batch(es)`);
  return { expiredCount };
});

await boss.createQueue(STOCK_COVERAGE_ALERT_QUEUE);
await boss.schedule(STOCK_COVERAGE_ALERT_QUEUE, "0 9 * * *", null, {
  tz: "America/Toronto",
});
await boss.work(STOCK_COVERAGE_ALERT_QUEUE, { batchSize: 1 }, async () => {
  const createdCount = await createDailyStockCoverageAlerts();
  console.info(`[worker] created ${createdCount} daily stock coverage alert(s)`);
  return { createdCount };
});

await boss.createQueue(JIFENG_FULFILLMENT_QUEUE);
await boss.schedule(JIFENG_FULFILLMENT_QUEUE, "* * * * *", null, {
  tz: "UTC",
});
await boss.work(JIFENG_FULFILLMENT_QUEUE, { batchSize: 1 }, async () => {
  const summary = await runJifengFulfillmentCycle();
  console.info(
    `[worker] Jifeng cycle enabled=${summary.enabled} enqueued=${summary.enqueuedCount} completed=${summary.processed.completed} retryScheduled=${summary.processed.retryScheduled} failed=${summary.processed.failed} shipped=${summary.statuses.shipped} exceptions=${summary.statuses.exceptions}`,
  );
  return summary;
});
console.info("[worker] Jifeng fulfillment cycle registered");

const feishuRequiredVariables = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_CARGO_WIKI_TOKEN",
  "FEISHU_INTERNAL_CHAT_ID",
] as const;
const configuredFeishuVariables = feishuRequiredVariables.filter(
  (name) => Boolean(process.env[name]),
);
if (
  configuredFeishuVariables.length > 0 &&
  configuredFeishuVariables.length !== feishuRequiredVariables.length
) {
  throw new Error("飞书集成仅配置了部分环境变量，请补齐后再启动任务进程");
}

if (configuredFeishuVariables.length === feishuRequiredVariables.length) {
  const feishuConfig = readFeishuConfig();
  const feishuClient = new FeishuClient({
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
  });
  await boss.createQueue(FEISHU_SYNC_QUEUE);
  await boss.schedule(FEISHU_SYNC_QUEUE, "* * * * *", null, { tz: "UTC" });
  await boss.work(FEISHU_SYNC_QUEUE, { batchSize: 1 }, async () => {
    await enqueueFeishuCargoSync({ reason: "five-minute-reconciliation" });
    const result = await processFeishuOutbox({
      botClient: feishuClient,
      cargoClient: feishuClient,
      config: feishuConfig,
    });
    console.info(
      `[worker] Feishu cycle cargo=${result.cargoCompleted} bot=${result.botCompleted} failed=${result.failed}`,
    );
    return result;
  });
  console.info("[worker] Feishu sheet and bot jobs enabled");
} else {
  console.info("[worker] Feishu jobs disabled: credentials not configured");
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
