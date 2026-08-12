import { describe, expect, it } from "vitest";

import { formatReplacementStatus } from "@/modules/fulfillment/replacement-ui-labels";

describe("formatReplacementStatus", () => {
  it("maps known replacement statuses to Chinese labels", () => {
    expect(formatReplacementStatus("PENDING_FULFILLMENT")).toBe("待履约");
    expect(formatReplacementStatus("EXCEPTION")).toBe("异常待处理");
    expect(formatReplacementStatus("SHIPPED")).toBe("已发货");
    expect(formatReplacementStatus("CANCELLED")).toBe("已取消");
  });

  it("falls back safely for unknown statuses", () => {
    expect(formatReplacementStatus("UNKNOWN")).toBe("未知状态（UNKNOWN）");
  });
});
