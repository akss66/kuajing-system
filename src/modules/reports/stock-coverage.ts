import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { db } from "@/db/client";
import { systemNotifications } from "@/db/schema";
import { createSystemNotification } from "@/modules/notifications/service";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import type { StockCoverageReportRow } from "./types";

const alertPriority: Record<StockCoverageReportRow["alertLevel"], number> = {
  CRITICAL: 0,
  WARNING: 1,
  NONE: 2,
  NO_BASELINE: 3,
};

export async function getStockCoverageReport(input?: {
  now?: Date;
}): Promise<StockCoverageReportRow[]> {
  const now = input?.now ?? new Date();
  const today = DateTime.fromJSDate(now, { zone: BUSINESS_TIME_ZONE }).startOf("day");
  const fromUtc = today.minus({ days: 7 }).toUTC().toISO()!;
  const toUtc = today.toUTC().toISO()!;
  const rows = await db.execute<{
    availableQuantity: number | string;
    shippedQuantity7d: number | string;
    skuCode: string;
    skuId: string;
    skuName: string;
    totalQuantity: number | string;
  }>(sql`
    with reserved as (
      select sku_id, sum(quantity) as quantity
      from inventory_reservations
      where status = 'ACTIVE'
      group by sku_id
    ), shipped as (
      select ol.sku_id, sum(ol.quantity) as quantity
      from order_lines ol
      join order_shipments os on os.id = ol.shipment_id
      where os.kind = 'NORMAL'
        and os.shipped_at >= ${fromUtc}::timestamptz
        and os.shipped_at < ${toUtc}::timestamptz
      group by ol.sku_id
    )
    select
      s.id as "skuId",
      s.sku_code as "skuCode",
      concat(p.name, ' · ', s.name) as "skuName",
      coalesce(ib.total_quantity, 0) as "totalQuantity",
      greatest(coalesce(ib.total_quantity, 0) - coalesce(r.quantity, 0), 0) as "availableQuantity",
      coalesce(sh.quantity, 0) as "shippedQuantity7d"
    from skus s
    join products p on p.id = s.product_id
    left join inventory_balances ib on ib.sku_id = s.id
    left join reserved r on r.sku_id = s.id
    left join shipped sh on sh.sku_id = s.id
    where s.sale_status = 'SELLABLE'
  `);

  return rows
    .map((row): StockCoverageReportRow => {
      const totalQuantity = Number(row.totalQuantity);
      const availableQuantity = Number(row.availableQuantity);
      const shippedQuantity7d = Number(row.shippedQuantity7d);
      const averageDailyQuantity = shippedQuantity7d / 7;
      const coverageDays = shippedQuantity7d > 0
        ? Math.round((availableQuantity * 7 / shippedQuantity7d) * 10) / 10
        : null;
      const alertLevel = coverageDays === null
        ? "NO_BASELINE"
        : coverageDays <= 30
          ? "CRITICAL"
          : coverageDays <= 40
            ? "WARNING"
            : "NONE";
      return {
        alertLevel,
        availableQuantity,
        averageDailyQuantity,
        coverageDays,
        shippedQuantity7d,
        skuCode: row.skuCode,
        skuId: row.skuId,
        skuName: row.skuName,
        totalQuantity,
      };
    })
    .sort(
      (left, right) =>
        alertPriority[left.alertLevel] - alertPriority[right.alertLevel] ||
        left.skuCode.localeCompare(right.skuCode),
    );
}

export async function createDailyStockCoverageAlerts(input?: { now?: Date }) {
  const now = input?.now ?? new Date();
  const reportDate = DateTime.fromJSDate(now, {
    zone: BUSINESS_TIME_ZONE,
  }).toISODate()!;
  const report = await getStockCoverageReport({ now });
  const alerts = report.filter(
    (row) => row.alertLevel === "CRITICAL" || row.alertLevel === "WARNING",
  );

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"stock-coverage:" + reportDate}))`,
    );
    let created = 0;
    for (const row of alerts) {
      const deduplicationKey = `stock-coverage:${reportDate}:${row.skuId}`;
      const [existing] = await tx
        .select({ id: systemNotifications.id })
        .from(systemNotifications)
        .where(eq(systemNotifications.deduplicationKey, deduplicationKey))
        .limit(1);
      if (existing) continue;
      const critical = row.alertLevel === "CRITICAL";
      await createSystemNotification(tx, {
        deduplicationKey,
        entityId: row.skuId,
        entityType: "SKU",
        message: `${row.skuCode} 当前可售 ${row.availableQuantity} 件，按最近 7 个完整自然日出库速度预计可售 ${row.coverageDays} 天。`,
        now,
        severity: critical ? "ERROR" : "WARNING",
        title: critical ? "库存不足 30 天" : "库存不足 40 天",
        type: critical ? "STOCK_COVERAGE_CRITICAL" : "STOCK_COVERAGE_WARNING",
      });
      created += 1;
    }
    return created;
  });
}
