import { DateTime } from "luxon";

import { BUSINESS_TIME_ZONE } from "@/shared/brand";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_DAYS = 366;

export class ReportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRangeError";
  }
}

function parseDate(value: string, label: string) {
  if (!ISO_DATE.test(value)) {
    throw new ReportRangeError(`${label}必须是 YYYY-MM-DD 格式`);
  }
  const parsed = DateTime.fromISO(value, { zone: BUSINESS_TIME_ZONE }).startOf("day");
  if (!parsed.isValid || parsed.toISODate() !== value) {
    throw new ReportRangeError(`${label}不是有效日期`);
  }
  return parsed;
}

export type TorontoDateRange = {
  fromDate: string;
  fromUtc: Date;
  toDate: string;
  toExclusiveUtc: Date;
};

export function parseTorontoDateRange(input: {
  from?: string;
  now?: Date;
  to?: string;
}): TorontoDateRange {
  const today = DateTime.fromJSDate(input.now ?? new Date(), {
    zone: BUSINESS_TIME_ZONE,
  }).startOf("day");
  const defaultTo = today;
  const defaultFrom = defaultTo.minus({ days: 6 });
  const from = input.from ? parseDate(input.from, "开始日期") : defaultFrom;
  const to = input.to ? parseDate(input.to, "结束日期") : defaultTo;
  const inclusiveDays = Math.floor(to.diff(from, "days").days) + 1;

  if (inclusiveDays < 1) {
    throw new ReportRangeError("开始日期不能晚于结束日期");
  }
  if (inclusiveDays > MAX_REPORT_DAYS) {
    throw new ReportRangeError(`报表日期范围不能超过 ${MAX_REPORT_DAYS} 天`);
  }

  return {
    fromDate: from.toISODate()!,
    fromUtc: from.toUTC().toJSDate(),
    toDate: to.toISODate()!,
    toExclusiveUtc: to.plus({ days: 1 }).toUTC().toJSDate(),
  };
}
