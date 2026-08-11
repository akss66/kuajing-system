import { PgBoss } from "pg-boss";

import { expirePendingPaymentOrders } from "@/modules/orders/lifecycle";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const EXPIRE_PENDING_ORDERS_QUEUE = "expire-pending-payment-orders";
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
