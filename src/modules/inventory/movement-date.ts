import { DateTime } from "luxon";

import { BUSINESS_TIME_ZONE } from "@/shared/brand";

export function inventoryDateBoundary(
  value: string | undefined,
  boundary: "start" | "end",
) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, {
    setZone: true,
    zone: BUSINESS_TIME_ZONE,
  }).setZone(BUSINESS_TIME_ZONE);
  if (!parsed.isValid || parsed.toISODate() !== value) return undefined;
  return (boundary === "end" ? parsed.endOf("day") : parsed.startOf("day")).toJSDate();
}
