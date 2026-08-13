import { createHash } from "node:crypto";

function normalizeToken(token: string) {
  return token.trim();
}

export function hashFeishuToken(token: string) {
  return createHash("sha256")
    .update(normalizeToken(token))
    .digest("hex");
}

export function feishuTokensMatch(left: string, right: string) {
  return hashFeishuToken(left) === hashFeishuToken(right);
}
