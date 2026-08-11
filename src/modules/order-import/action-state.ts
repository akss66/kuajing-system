export type TemuUploadActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  batchId?: string;
};

export const INITIAL_TEMU_UPLOAD_STATE: TemuUploadActionState = {
  status: "idle",
};
