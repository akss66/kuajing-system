export type JifengConnectionStatus =
  | "DISCONNECTED"
  | "AUTHORIZED"
  | "RESOURCE_SELECTION_REQUIRED"
  | "READY_DISABLED"
  | "ENABLED"
  | "REFRESH_REQUIRED"
  | "ERROR";

export type EncryptedSecret = {
  version: 1;
  ciphertext: string;
  iv: string;
  tag: string;
};
