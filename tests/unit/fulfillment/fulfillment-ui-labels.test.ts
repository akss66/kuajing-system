import { describe, expect, it } from "vitest";

import { safeFulfillmentError } from "@/modules/fulfillment/fulfillment-ui-labels";

describe("safeFulfillmentError", () => {
  it("keeps documented Jifeng business codes actionable", () => {
    expect(safeFulfillmentError("50026")).toEqual({
      message: "请在极风后台处理仓库库存问题；系统只匹配已有订单，不会另建订单。",
      title: "极风仓库库存不足（50026）",
    });
  });

  it.each(["50017", "50071"])(
    "explains how to submit an OMS platform order before warehouse matching for %s",
    (code) => {
      expect(safeFulfillmentError(code)).toEqual({
        message:
          "已匹配到极风订单，请在极风后台选择物流渠道并提交仓库；系统随后自动同步。",
        title: "待在极风后台提交仓库",
      });
    },
  );

  it.each([
    "POST_SUCCESS_PERSISTENCE_ERROR",
    "RECONCILIATION_REQUIRED:NETWORK_ERROR",
    "CONFIRMED_NOT_FOUND:TIMEOUT",
  ])("hides internal recovery code %s", (code) => {
    const presentation = safeFulfillmentError(
      code,
      "duplicate key value violates secret_table_constraint",
    );

    expect(`${presentation.title} ${presentation.message}`).not.toContain(code);
    expect(`${presentation.title} ${presentation.message}`).not.toContain("secret_table_constraint");
  });

  it("does not echo unknown stored messages", () => {
    expect(safeFulfillmentError("INTERNAL_ERROR", "postgres://secret@db/internal"))
      .toEqual({
        message: "系统会按计划重试；如持续失败，请检查集成状态或联系技术人员。",
        title: "极风履约暂时异常",
      });
  });
});
