import { describe, expect, it } from "vitest";

import {
  getCustomerSettlementOrderStatusLabel,
  getCustomerWalletHoldStatusLabel,
} from "@/modules/settlement/customer-ui-labels";

describe("customer settlement UI labels", () => {
  it("uses the same customer-facing order status language as the order workspace", () => {
    expect(getCustomerSettlementOrderStatusLabel("FULFILLING")).toBe("仓库处理中");
    expect(getCustomerSettlementOrderStatusLabel("FULFILLMENT_EXCEPTION")).toBe("需要协助");
    expect(getCustomerSettlementOrderStatusLabel("SHIPPED")).toBe("已发货");
  });

  it("keeps wallet hold enums out of customer-facing copy", () => {
    expect(getCustomerWalletHoldStatusLabel("ACTIVE")).toBe("冻结中");
    expect(getCustomerWalletHoldStatusLabel("CONSUMED")).toBe("已抵扣");
    expect(getCustomerWalletHoldStatusLabel("RELEASED")).toBe("已释放");
  });
});
