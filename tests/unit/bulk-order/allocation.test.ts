import { describe, expect, it } from "vitest";

import { allocateWalletFen } from "@/modules/bulk-order/allocation";

describe("allocateWalletFen", () => {
  it("按订单金额比例分摊，并把尾差优先补给金额最大的订单", () => {
    expect(
      allocateWalletFen(
        [
          { orderId: "b", totalAmountFen: 100 },
          { orderId: "a", totalAmountFen: 100 },
          { orderId: "c", totalAmountFen: 101 },
        ],
        100,
      ),
    ).toEqual([
      { offlineFen: 67, orderId: "a", walletFen: 33 },
      { offlineFen: 67, orderId: "b", walletFen: 33 },
      { offlineFen: 67, orderId: "c", walletFen: 34 },
    ]);
  });

  it("金额相同时按订单 ID 稳定补齐尾差", () => {
    expect(
      allocateWalletFen(
        [
          { orderId: "b", totalAmountFen: 100 },
          { orderId: "a", totalAmountFen: 100 },
        ],
        1,
      ),
    ).toEqual([
      { offlineFen: 99, orderId: "a", walletFen: 1 },
      { offlineFen: 100, orderId: "b", walletFen: 0 },
    ]);
  });

  it("把抵扣金额限制在订单总额内", () => {
    expect(
      allocateWalletFen([{ orderId: "a", totalAmountFen: 500 }], 800),
    ).toEqual([{ offlineFen: 0, orderId: "a", walletFen: 500 }]);
  });

  it("金额乘积超过安全整数范围时仍按整数比例精确分摊", () => {
    expect(
      allocateWalletFen(
        [
          { orderId: "a", totalAmountFen: 523_944_800 },
          { orderId: "b", totalAmountFen: 877_650_354 },
        ],
        1_193_474_773,
      ),
    ).toEqual([
      {
        offlineFen: 77_799_636,
        orderId: "a",
        walletFen: 446_145_164,
      },
      {
        offlineFen: 130_320_745,
        orderId: "b",
        walletFen: 747_329_609,
      },
    ]);
  });

  it("拒绝负金额、重复订单 ID 和空订单上的非零抵扣", () => {
    expect(() =>
      allocateWalletFen([{ orderId: "a", totalAmountFen: 1 }], -1),
    ).toThrow("余额抵扣不能为负数");
    expect(() =>
      allocateWalletFen([{ orderId: "a", totalAmountFen: -1 }], 0),
    ).toThrow("订单金额不能为负数");
    expect(() =>
      allocateWalletFen(
        [
          { orderId: "a", totalAmountFen: 1 },
          { orderId: "a", totalAmountFen: 1 },
        ],
        1,
      ),
    ).toThrow("订单 ID 不能重复");
    expect(() => allocateWalletFen([], 1)).toThrow(
      "没有订单时余额抵扣必须为 0",
    );
  });
});
