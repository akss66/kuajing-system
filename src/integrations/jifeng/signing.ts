import { createHmac, randomBytes } from "node:crypto";

export type JifengSigningInput = {
  accessToken: string;
  clientId: string;
  method: "post";
  nonce: string;
  timestamp: string;
  url: string;
  userId: string;
};

export function buildJifengCanonicalString(input: JifengSigningInput) {
  return Object.entries(input)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
}

export function signJifengRequest(
  clientSecret: string,
  input: JifengSigningInput,
) {
  return createHmac("sha256", clientSecret)
    .update(buildJifengCanonicalString(input), "utf8")
    .digest("hex");
}

export function createJifengNonce() {
  return BigInt.asUintN(63, randomBytes(8).readBigUInt64BE()).toString();
}
