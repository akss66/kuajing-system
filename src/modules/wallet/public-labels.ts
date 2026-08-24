export type WalletTransactionKind =
  | "ADMIN_CREDIT"
  | "ADMIN_DEBIT"
  | "ORDER_DEBIT"
  | "ORDER_REFUND";

export type WalletHoldState = "ACTIVE" | "CONSUMED" | "RELEASED";

export function publicWalletTransactionReason(type: WalletTransactionKind) {
  switch (type) {
    case "ADMIN_CREDIT":
      return "余额充值";
    case "ADMIN_DEBIT":
      return "余额调整扣减";
    case "ORDER_DEBIT":
      return "订单余额支付";
    case "ORDER_REFUND":
      return "订单退款";
  }
}

export function publicWalletHoldReleaseReason(status: WalletHoldState) {
  switch (status) {
    case "ACTIVE":
      return null;
    case "CONSUMED":
      return "已用于结算";
    case "RELEASED":
      return "冻结金额已释放";
  }
}
