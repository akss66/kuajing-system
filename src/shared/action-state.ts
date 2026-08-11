export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string[]>;
};

export const INITIAL_ACTION_STATE: ActionState = { status: "idle" };

export type ManagedAction = (
  previousState: ActionState,
  formData: FormData,
) => Promise<ActionState>;
