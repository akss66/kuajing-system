import { describe, expect, it } from "vitest";

import {
  getAdminBulkDraftStatusLabel,
  getAdminSettlementAuditActionLabel,
} from "@/modules/settlement/admin-ui-labels";

describe("admin UI labels", () => {
  it("maps settlement payment audit actions to explicit Chinese labels", () => {
    expect(getAdminSettlementAuditActionLabel("SETTLEMENT_PAYMENT_REPORTED"))
      .toBe("客户提交付款声明");
    expect(getAdminSettlementAuditActionLabel("SETTLEMENT_PAYMENT_APPROVED"))
      .toBe("管理员已确认到账");
    expect(getAdminSettlementAuditActionLabel("SETTLEMENT_PAYMENT_REJECTED"))
      .toBe("管理员已拒绝付款声明");
    expect(getAdminSettlementAuditActionLabel("SETTLEMENT_PAYMENT_WITHDRAWN"))
      .toBe("客户已撤回付款声明");
    expect(getAdminSettlementAuditActionLabel("SETTLEMENT_PAYMENT_EXPIRED"))
      .toBe("付款声明已过期");
    expect(getAdminSettlementAuditActionLabel("UNMAPPED_BACKEND_ACTION"))
      .toBe("结算记录已更新");
  });

  it("shows draft lifecycle labels separately from validation labels", () => {
    expect(getAdminBulkDraftStatusLabel("DRAFT")).toBe("草稿待提交");
    expect(getAdminBulkDraftStatusLabel("PARTIALLY_SUBMITTED")).toBe("部分店铺已提交");
    expect(getAdminBulkDraftStatusLabel("COMPLETED")).toBe("全部店铺已提交");
    expect(getAdminBulkDraftStatusLabel("UNKNOWN_BACKEND_STATUS"))
      .toBe("状态处理中");
  });
});
