import { describe, expect, test } from "vitest";

import { deriveParentFulfillmentStatus } from "@/modules/fulfillment/order-rollup";

describe("deriveParentFulfillmentStatus", () => {
  test.each([
    { expected: "PAID_PENDING_FULFILLMENT", statuses: [] },
    { expected: "FULFILLING", statuses: ["PENDING", "SUBMITTED"] },
    { expected: "SHIPPED", statuses: ["SHIPPED", "SHIPPED"] },
    { expected: "FULFILLMENT_EXCEPTION", statuses: ["PENDING", "EXCEPTION"] },
    { expected: "FULFILLMENT_EXCEPTION", statuses: ["SHIPPED", "CANCELLED"] },
  ])("derives $expected from $statuses", ({ expected, statuses }) => {
    expect(deriveParentFulfillmentStatus(statuses)).toBe(expected);
  });
});
