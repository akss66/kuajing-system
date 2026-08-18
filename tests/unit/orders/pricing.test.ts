import { describe, expect, test } from "vitest";

import {
  PACKAGE_SHIPPING_FEE_FEN,
  calculateOrderPricing,
} from "@/modules/orders/pricing";

describe("order pricing", () => {
  test("charges 13 yuan for each distinct external order package", () => {
    expect(PACKAGE_SHIPPING_FEE_FEN).toBe(1_300);
    expect(
      calculateOrderPricing({
        merchandiseAmountFen: 500,
        packageCount: 1,
      }),
    ).toEqual({
      merchandiseAmountFen: 500,
      shippingFeeFen: 1_300,
      totalAmountFen: 1_800,
    });

    expect(
      calculateOrderPricing({
        merchandiseAmountFen: 500,
        packageCount: 2,
      }).totalAmountFen,
    ).toBe(3_100);
  });

  test("rejects invalid package counts and integer overflow", () => {
    expect(() =>
      calculateOrderPricing({ merchandiseAmountFen: 500, packageCount: -1 }),
    ).toThrow("包裹数量");
    expect(() =>
      calculateOrderPricing({
        merchandiseAmountFen: 2_147_483_000,
        packageCount: 1,
      }),
    ).toThrow("订单金额");
  });
});
