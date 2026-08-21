import type { AllocationOrder, WalletAllocation } from "./types";

function assertInteger(value: number, message: string) {
  if (!Number.isSafeInteger(value)) throw new Error(message);
}

function safeBigIntToNumber(value: bigint, message: string) {
  const result = Number(value);
  assertInteger(result, message);
  return result;
}

export function allocateWalletFen(
  orders: readonly AllocationOrder[],
  requestedFen: number,
): WalletAllocation[] {
  assertInteger(requestedFen, "余额抵扣必须是整数分");
  if (requestedFen < 0) throw new Error("余额抵扣不能为负数");
  if (orders.length === 0) {
    if (requestedFen !== 0) throw new Error("没有订单时余额抵扣必须为 0");
    return [];
  }

  const orderIds = new Set<string>();
  let totalAmountFen = 0;
  for (const order of orders) {
    assertInteger(order.totalAmountFen, "订单金额必须是整数分");
    if (order.totalAmountFen < 0) throw new Error("订单金额不能为负数");
    if (orderIds.has(order.orderId)) throw new Error("订单 ID 不能重复");
    orderIds.add(order.orderId);
    totalAmountFen += order.totalAmountFen;
    assertInteger(totalAmountFen, "订单总额超过安全范围");
  }

  const walletTotalFen = Math.min(requestedFen, totalAmountFen);
  if (totalAmountFen === 0) {
    return [...orders]
      .sort((first, second) => first.orderId.localeCompare(second.orderId))
      .map((order) => ({
        offlineFen: 0,
        orderId: order.orderId,
        walletFen: 0,
      }));
  }

  const walletTotalBigInt = BigInt(walletTotalFen);
  const totalAmountBigInt = BigInt(totalAmountFen);
  const allocations = orders.map((order) => ({
    orderId: order.orderId,
    totalAmountFen: order.totalAmountFen,
    walletFen: safeBigIntToNumber(
      (walletTotalBigInt * BigInt(order.totalAmountFen)) / totalAmountBigInt,
      "余额分摊金额超过安全范围",
    ),
  }));
  let remainderFen =
    walletTotalFen -
    allocations.reduce((sum, allocation) => sum + allocation.walletFen, 0);

  for (const allocation of [...allocations].sort(
    (first, second) =>
      second.totalAmountFen - first.totalAmountFen ||
      first.orderId.localeCompare(second.orderId),
  )) {
    if (remainderFen <= 0) break;
    allocation.walletFen += 1;
    remainderFen -= 1;
  }

  return allocations
    .sort((first, second) => first.orderId.localeCompare(second.orderId))
    .map((allocation) => ({
      offlineFen: allocation.totalAmountFen - allocation.walletFen,
      orderId: allocation.orderId,
      walletFen: allocation.walletFen,
    }));
}
