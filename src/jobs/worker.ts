import { PgBoss } from "pg-boss";

import {
  areExpectedWorkersActive,
  createWorkerHealthMonitor,
} from "@/jobs/worker-health";
import { FeishuClient } from "@/integrations/feishu/client";
import {
  canProcessFeishuBot,
  canWriteFeishuCargo,
  hasFeishuRuntimeConfiguration,
  readFeishuApiBaseUrl,
  readFeishuConfig,
} from "@/integrations/feishu/config";
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
const expectedWorkerQueues = [
  EXPIRE_PENDING_ORDERS_QUEUE,
  EXPIRE_SETTLEMENT_BATCHES_QUEUE,
  JIFENG_FULFILLMENT_QUEUE,
  STOCK_COVERAGE_ALERT_QUEUE,
];
const workerHealth = createWorkerHealthMonitor({
  schedulerProbe: () =>
    areExpectedWorkersActive(boss.getWipData(), expectedWorkerQueues),
});
workerHealth.start();

boss.on("error", (error) => {
  console.error("[worker] pg-boss error", safeLogError(error));
});

await boss.start();
await boss.createQueue(EXPIRE_PENDING_ORDERS_QUEUE);
await boss.createQueue(EXPIRE_SETTLEMENT_BATCHES_QUEUE);

await boss.schedule(EXPIRE_PENDING_ORDERS_QUEUE, "* * * * *", null, {
  tz: "UTC",
});
await boss.schedule(EXPIRE_SETTLEMENT_BATCHES_QUEUE, "* * * * *", null, {
  tz: "UTC",
});

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
    `[worker] Jifeng cycle enabled=${summary.enabled} enqueued=${summary.enqueuedCount} completed=${summary.processed.completed} retryScheduled=${summary.processed.retryScheduled} failed=${summary.processed.failed} shipped=${summary.statuses.shipped} exceptions=${summary.statuses.exceptions} pollFailures=${summary.statuses.pollFailures}`,
  );
  return summary;
});
console.info("[worker] Jifeng fulfillment cycle registered");

const hasAnyFeishuConfiguration = hasFeishuRuntimeConfiguration();

if (hasAnyFeishuConfiguration) {
  const feishuConfig = readFeishuConfig();
  const cargoWriterEnabled = canWriteFeishuCargo(feishuConfig);
  const botEnabled = canProcessFeishuBot(feishuConfig);

  if (cargoWriterEnabled || botEnabled) {
    const feishuClient = new FeishuClient({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      baseUrl: readFeishuApiBaseUrl(),
    });
    await boss.createQueue(FEISHU_SYNC_QUEUE);
    await boss.schedule(FEISHU_SYNC_QUEUE, "* * * * *", null, { tz: "UTC" });
    await boss.work(FEISHU_SYNC_QUEUE, { batchSize: 1 }, async () => {
      if (cargoWriterEnabled) {
        await enqueueFeishuCargoSync({ reason: "five-minute-reconciliation" });
      }
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
    expectedWorkerQueues.push(FEISHU_SYNC_QUEUE);
    console.info(
      `[worker] Feishu jobs enabled: cargo=${cargoWriterEnabled ? "on" : "off"} bot=${botEnabled ? "on" : "off"}`,
    );
  } else {
    console.info("[worker] Feishu writer disabled: source preflight only");
  }
} else {
  console.info("[worker] Feishu jobs disabled: credentials not configured");
}

workerHealth.markReady();
console.info("[worker] background jobs started");

let stopping = false;
async function stopWorker(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info(`[worker] received ${signal}, stopping`);
  try {
    workerHealth.markStopping();
  } catch {
    console.error("[worker] failed to publish stopping health state");
  }
  await boss.stop({ close: true, graceful: true, timeout: 30_000 });
  workerHealth.stop();
  process.exit(0);
}

process.once("SIGINT", () => void stopWorker("SIGINT"));
process.once("SIGTERM", () => void stopWorker("SIGTERM"));
