import { eq, sql } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { fulfillmentOrders } from "@/db/schema";

type ParentFulfillmentStatus =
  | "PAID_PENDING_FULFILLMENT"
  | "FULFILLING"
  | "SHIPPED"
  | "FULFILLMENT_EXCEPTION";

export function deriveParentFulfillmentStatus(
  shipmentStatuses: string[],
): ParentFulfillmentStatus {
  if (shipmentStatuses.length === 0) return "PAID_PENDING_FULFILLMENT";
  if (
    shipmentStatuses.some((status) =>
      ["CANCELLED", "EXCEPTION"].includes(status),
    )
  ) {
    return "FULFILLMENT_EXCEPTION";
  }
  if (shipmentStatuses.every((status) => status === "SHIPPED")) return "SHIPPED";
  return "FULFILLING";
}

export async function refreshParentFulfillmentStatus(
  tx: DbTransaction,
  input: { now: Date; orderId: string },
) {
  const orderRows = await tx.execute<{ status: string }>(sql`
    select status
    from fulfillment_orders
    where id = ${input.orderId}
    for update
  `);
  if (!orderRows[0] || ["CANCELLED", "EXPIRED"].includes(orderRows[0].status)) {
    return orderRows[0]?.status ?? null;
  }
  const rows = await tx.execute<{ status: string }>(sql`
    select coalesce(f.status::text, 'PENDING') as status
    from order_shipments s
    left join shipment_fulfillments f on f.shipment_id = s.id
    where s.order_id = ${input.orderId}
      and s.kind = 'NORMAL'
    order by s.id
  `);
  const status = deriveParentFulfillmentStatus(rows.map((row) => row.status));
  await tx
    .update(fulfillmentOrders)
    .set({ status, updatedAt: input.now })
    .where(eq(fulfillmentOrders.id, input.orderId));
  return status;
}
