export const PACKAGE_SHIPPING_FEE_FEN = 1_300;

const MAX_DATABASE_INTEGER = 2_147_483_647;

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label}必须是非负整数`);
  }
}

export function calculateOrderPricing(input: {
  merchandiseAmountFen: number;
  packageCount: number;
}) {
  assertNonNegativeInteger(input.merchandiseAmountFen, "货品金额");
  assertNonNegativeInteger(input.packageCount, "包裹数量");

  const shippingFeeFen = input.packageCount * PACKAGE_SHIPPING_FEE_FEN;
  const totalAmountFen = input.merchandiseAmountFen + shippingFeeFen;
  if (
    !Number.isSafeInteger(shippingFeeFen) ||
    !Number.isSafeInteger(totalAmountFen) ||
    totalAmountFen > MAX_DATABASE_INTEGER
  ) {
    throw new RangeError("订单金额超出系统范围");
  }

  return {
    merchandiseAmountFen: input.merchandiseAmountFen,
    shippingFeeFen,
    totalAmountFen,
  } as const;
}
