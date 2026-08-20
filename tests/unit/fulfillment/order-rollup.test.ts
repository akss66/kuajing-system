import { describe, expect, test } from "vitest";

import { deriveParentFulfillmentStatus } from "@/modules/fulfillment/order-rollup";

describe("deriveParentFulfillmentStatus", () => {
  test.each([
    { expected: "PAID_PENDING_FULFILLMENT", statuses: [] },
    { expected: "FULFILLING", statuses: ["PENDING", "SUBMITTED"] },
    { expected: "SHIPPED", statuses: ["SHIPPED", "SHIPPED"] },
    { expected: "FULFILLMENT_EXCEPTION", statuses: ["PENDING", "EXCEPTION"] },
    { expected: "SHIPPED", statuses: ["SHIPPED", "CANCELLED"] },
    { expected: "CANCELLED", statuses: ["CANCELLED", "CANCELLED"] },
  ])("derives $expected from $statuses", ({ expected, statuses }) => {
    expect(deriveParentFulfillmentStatus(statuses)).toBe(expected);
  });
});
