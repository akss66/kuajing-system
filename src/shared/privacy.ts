const sensitiveKey = /(secret|token|password|authorization|cookie|recipient|address|phone|email|wechat)/i;

function codePoints(value: string) {
  return Array.from(value.trim());
}

export function maskName(value: string) {
  const characters = codePoints(value);
  if (characters.length === 0) return "";
  return characters[0] + "*".repeat(Math.max(1, characters.length - 1));
}

export function maskPhone(value: string) {
  const characters = codePoints(value);
  if (characters.length <= 4) return "*".repeat(characters.length);
  return "*".repeat(characters.length - 4) + characters.slice(-4).join("");
}

export function maskEmail(value: string) {
  const normalized = value.trim();
  const at = normalized.indexOf("@");
  if (at <= 0) return "***";
  return `${normalized[0]}***${normalized.slice(at)}`;
}

export function maskAddress(value: string) {
  const characters = codePoints(value);
  if (characters.length <= 6) return "*".repeat(characters.length);
  return `${characters.slice(0, 6).join("")}…`;
}

export function maskWechat(value: string) {
  const characters = codePoints(value);
  if (characters.length <= 2) return "**";
  return `${characters.slice(0, 2).join("")}***`;
}

export function redactSensitiveText(value: string) {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:clientSecret|accessToken|refreshToken|password|token)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(Authorization\s*:\s*)(?!Bearer)[^\s,]+/gi, "$1[REDACTED]");
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : sanitizeForLog(entry),
    ]),
  );
}

export function safeLogError(error: unknown) {
  if (error instanceof Error) {
    return sanitizeForLog({ message: error.message, name: error.name });
  }
  return sanitizeForLog({ message: String(error), name: "UnknownError" });
}
