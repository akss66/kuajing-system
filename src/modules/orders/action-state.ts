export type SubmitOrderActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  orderId?: string;
};

export const INITIAL_SUBMIT_ORDER_STATE: SubmitOrderActionState = {
  status: "idle",
};
