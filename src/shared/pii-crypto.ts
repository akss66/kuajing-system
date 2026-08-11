import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export function parsePiiEncryptionKey(
  encodedKey = process.env.PII_ENCRYPTION_KEY,
): Buffer {
  if (!encodedKey) {
    throw new Error("PII_ENCRYPTION_KEY 未配置");
  }

  if (!BASE64_PATTERN.test(encodedKey)) {
    throw new Error("PII_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥");
  }

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("PII_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥");
  }

  return key;
}

export function encryptPii(value: unknown, key = parsePiiEncryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptPii<T>(
  encrypted: string,
  key = parsePiiEncryptionKey(),
): T {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
      encrypted.split(".");
    if (
      version !== VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra
    ) {
      throw new Error("invalid envelope");
    }

    const iv = Buffer.from(encodedIv, "base64url");
    const authTag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error("invalid envelope lengths");
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error("无法解密敏感信息");
  }
}
