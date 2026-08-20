import { eq, sql } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { fulfillmentOrders } from "@/db/schema";

type ParentFulfillmentStatus =
  | "PENDING_PAYMENT"
  | "PAID_PENDING_FULFILLMENT"
  | "FULFILLING"
  | "SHIPPED"
  | "FULFILLMENT_EXCEPTION"
  | "CANCELLED";

export function deriveParentFulfillmentStatus(
  shipmentStatuses: string[],
): ParentFulfillmentStatus {
  if (shipmentStatuses.length === 0) return "PAID_PENDING_FULFILLMENT";
  if (shipmentStatuses.every((status) => status === "CANCELLED")) return "CANCELLED";
  const activeStatuses = shipmentStatuses.filter((status) => status !== "CANCELLED");
  if (activeStatuses.some((status) => status === "EXCEPTION")) {
    return "FULFILLMENT_EXCEPTION";
  }
  if (activeStatuses.every((status) => status === "SHIPPED")) return "SHIPPED";
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
  const shipmentStatuses = rows.map((row) => row.status);
  const cancelledCount = shipmentStatuses.filter((status) => status === "CANCELLED").length;
  const cancellationState =
    cancelledCount === 0
      ? "NONE"
      : cancelledCount === shipmentStatuses.length
        ? "ALL"
        : "PARTIAL";
  const activeStatuses = shipmentStatuses.filter((status) => status !== "CANCELLED");
  let status = deriveParentFulfillmentStatus(shipmentStatuses);
  if (orderRows[0].status === "PENDING_PAYMENT" && status !== "CANCELLED") {
    status = "PENDING_PAYMENT";
  }
  if (
    orderRows[0].status === "PAID_PENDING_FULFILLMENT" &&
    activeStatuses.length > 0 &&
    activeStatuses.every((shipmentStatus) => shipmentStatus === "PENDING")
  ) {
    status = orderRows[0].status as "PENDING_PAYMENT" | "PAID_PENDING_FULFILLMENT";
  }
  await tx
    .update(fulfillmentOrders)
    .set({
      cancelReason: status === "CANCELLED" ? "所有子包裹均已取消" : null,
      cancellationState,
      cancelledAt: status === "CANCELLED" ? input.now : null,
      status,
      updatedAt: input.now,
    })
    .where(eq(fulfillmentOrders.id, input.orderId));
  return status;
}
