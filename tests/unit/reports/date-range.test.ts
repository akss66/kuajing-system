import { describe, expect, test } from "vitest";

import { parseTorontoDateRange, ReportRangeError } from "@/modules/reports/date-range";

describe("Toronto report date range", () => {
  test("uses Toronto midnight and includes the entire end date across DST", () => {
    const range = parseTorontoDateRange({ from: "2026-03-07", to: "2026-03-08" });

    expect(range.fromDate).toBe("2026-03-07");
    expect(range.toDate).toBe("2026-03-08");
    expect(range.fromUtc.toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(range.toExclusiveUtc.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  test("keeps winter dates on the standard UTC offset", () => {
    const range = parseTorontoDateRange({ from: "2026-01-15", to: "2026-01-15" });

    expect(range.fromUtc.toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(range.toExclusiveUtc.toISOString()).toBe("2026-01-16T05:00:00.000Z");
  });

  test("defaults to the last seven Toronto dates including today", () => {
    const range = parseTorontoDateRange({ now: new Date("2026-08-12T03:30:00.000Z") });

    expect(range.fromDate).toBe("2026-08-05");
    expect(range.toDate).toBe("2026-08-11");
  });

  test.each([
    { from: "not-a-date", to: "2026-08-12" },
    { from: "2026-08-13", to: "2026-08-12" },
    { from: "2025-01-01", to: "2026-08-12" },
  ])("rejects invalid or unsafe ranges: %o", (input) => {
    expect(() => parseTorontoDateRange(input)).toThrow(ReportRangeError);
  });
});
