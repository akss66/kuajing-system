export type FulfillmentErrorPresentation = {
  message: string;
  title: string;
};

const retryableConnectionCodes = new Set([
  "INTERNAL_ERROR",
  "INVALID_RESPONSE",
  "NETWORK_ERROR",
  "STALE_PROCESSING",
  "TIMEOUT",
]);

export function safeFulfillmentError(
  code: string,
  storedMessage?: string | null,
): FulfillmentErrorPresentation {
  void storedMessage;
  if (code === "MANUAL_CONFIRMED_FAILURE_RETRY") {
    return {
      message: "当前包裹已加入处理队列，请勿重复操作。",
      title: "已提交重试，等待系统处理",
    };
  }
  if (code === "50026") {
    return {
      message: "请先同步或补充极风仓库库存，再重试当前包裹。",
      title: "极风仓库库存不足（50026）",
    };
  }
  if (code === "50019" || code === "50038") {
    return {
      message: "系统会先查询现有极风订单，确认结果前不会盲目重复创建。",
      title: `极风订单正在核对（${code}）`,
    };
  }
  if (
    code === "POST_SUCCESS_PERSISTENCE_ERROR" ||
    code.startsWith("RECONCILIATION_REQUIRED:")
  ) {
    return {
      message: "远端订单结果尚未安全确认，请先核对极风订单再按页面指引重试。",
      title: "极风订单结果待核对",
    };
  }
  if (code.startsWith("CONFIRMED_NOT_FOUND:")) {
    return {
      message: "系统已确认极风不存在该订单，可按页面指引重新提交。",
      title: "极风订单未创建",
    };
  }
  if (code === "CANCEL_FAILED") {
    return {
      message: "尚未确认远端取消成功，库存不会提前释放，请稍后重试。",
      title: "极风取消失败",
    };
  }
  if (code === "SHIPMENT_CANCELLED" || code === "ORDER_CANCELLED") {
    return {
      message: "该包裹已终止处理，不会继续推送或扣减库存。",
      title: "包裹已取消",
    };
  }
  if (
    retryableConnectionCodes.has(code) ||
    code.startsWith("HTTP_")
  ) {
    return {
      message: "系统会按计划重试；如持续失败，请检查集成状态或联系技术人员。",
      title: "极风履约暂时异常",
    };
  }
  if (/^\d+$/.test(code)) {
    return {
      message: "请在极风后台核查当前包裹，确认原因后再决定是否重试。",
      title: `极风返回业务错误（${code}）`,
    };
  }
  return {
    message: "请根据包裹状态重试，或前往系统集成页检查极风连接。",
    title: "履约处理异常",
  };
}
