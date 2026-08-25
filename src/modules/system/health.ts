import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { checkWorkerHealth, type WorkerHealthAssessment } from "@/jobs/worker-health";

type CountRow = { value: number | string };

function count(rows: CountRow[]) {
  return Number(rows[0]?.value ?? 0);
}

type WorkerHealthOptions = {
  filePath?: string;
  required?: boolean;
};

export type PublicWorkerHealth =
  | "healthy"
  | "invalid"
  | "missing"
  | "not_configured"
  | "scheduler_inactive"
  | "stale"
  | "starting"
  | "stopping";

function shouldRequireWorkerHealth(options?: WorkerHealthOptions) {
  if (typeof options?.required === "boolean") return options.required;
  return Boolean(options?.filePath ?? process.env.WORKER_HEALTH_FILE);
}

function assessSharedWorkerHealth(
  now: Date,
  options?: WorkerHealthOptions,
): WorkerHealthAssessment | null {
  const filePath = options?.filePath ?? process.env.WORKER_HEALTH_FILE;
  if (!shouldRequireWorkerHealth({ ...options, filePath })) return null;
  return checkWorkerHealth({
    filePath,
    now,
    // The web container reads a heartbeat written by the worker container,
    // so PID probing would always fail across isolated container namespaces.
    processProbe: () => true,
  });
}

function toPublicWorkerHealth(
  assessment: WorkerHealthAssessment | null,
): PublicWorkerHealth {
  if (assessment === null) return "not_configured";
  switch (assessment.code) {
    case "HEALTHY":
      return "healthy";
    case "HEARTBEAT_MISSING":
      return "missing";
    case "HEARTBEAT_STALE":
      return "stale";
    case "NOT_READY":
      return "starting";
    case "SCHEDULER_INACTIVE":
      return "scheduler_inactive";
    case "STOPPING":
      return "stopping";
    case "INVALID_HEARTBEAT":
    case "PROCESS_MISSING":
      return "invalid";
  }
}

export async function getRuntimeHealth(input?: {
  now?: Date;
  workerHealth?: WorkerHealthOptions;
}) {
  await db.execute(sql`select 1`);
  const workerAssessment = assessSharedWorkerHealth(
    input?.now ?? new Date(),
    input?.workerHealth,
  );
  const worker = toPublicWorkerHealth(workerAssessment);
  return {
    database: "healthy" as const,
    status:
      workerAssessment && !workerAssessment.healthy
        ? ("degraded" as const)
        : ("ok" as const),
    worker,
  };
}

export async function getOperationalHealth(input?: {
  now?: Date;
  workerHealth?: WorkerHealthOptions;
}) {
  const now = input?.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 10 * 60_000);
  const worker = assessSharedWorkerHealth(now, input?.workerHealth);
  const [failed, stale, overReserved, walletMismatch, missingTracking] =
    await Promise.all([
      db.execute<CountRow>(sql`
        select count(*) as value
        from integration_outbox
        where status = 'FAILED'
      `),
      db.execute<CountRow>(sql`
        select count(*) as value
        from integration_outbox
        where status = 'PROCESSING'
          and locked_at < ${staleBefore.toISOString()}::timestamptz
      `),
      db.execute<CountRow>(sql`
        select count(*) as value
        from (
          select ib.sku_id
          from inventory_balances ib
          join inventory_reservations ir
            on ir.sku_id = ib.sku_id and ir.status = 'ACTIVE'
          group by ib.sku_id, ib.total_quantity
          having sum(ir.quantity) > ib.total_quantity
        ) inconsistent_inventory
      `),
      db.execute<CountRow>(sql`
        with latest as (
          select distinct on (customer_id)
            customer_id,
            after_balance_fen
          from wallet_transactions
          order by customer_id, created_at desc, id desc
        )
        select count(*) as value
        from wallet_accounts wa
        left join latest on latest.customer_id = wa.customer_id
        where wa.balance_fen <> coalesce(latest.after_balance_fen, 0)
      `),
      db.execute<CountRow>(sql`
        select count(*) as value
        from order_shipments
        where shipped_at is not null
          and nullif(trim(tracking_number), '') is null
      `),
    ]);
  const checks = {
    failedIntegrations: count(failed),
    overReservedSkus: count(overReserved),
    shippedWithoutTracking: count(missingTracking),
    staleProcessingIntegrations: count(stale),
    walletMismatches: count(walletMismatch),
    workerHeartbeatFailures: worker && !worker.healthy ? 1 : 0,
  };
  return {
    checkedAt: now.toISOString(),
    checks,
    status: Object.values(checks).some((value) => value > 0)
      ? ("DEGRADED" as const)
      : ("HEALTHY" as const),
    worker:
      worker === null
        ? null
        : {
            code: worker.code,
            healthy: worker.healthy,
          },
  };
}

export async function checkDatabaseHealth(input?: { now?: Date; workerHealth?: WorkerHealthOptions }) {
  await db.execute(sql`select 1`);
  const worker = assessSharedWorkerHealth(input?.now ?? new Date(), input?.workerHealth);
  if (worker && !worker.healthy) {
    throw new Error(`WORKER_HEALTH_${worker.code}`);
  }
}
