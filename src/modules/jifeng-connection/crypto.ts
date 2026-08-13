import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { EncryptedSecret } from "./types";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ERROR_MESSAGE = "Unable to process Jifeng secret";

export class JifengSecretError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = "JifengSecretError";
  }
}

function validateKey(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new JifengSecretError();
  }
}

function decodeBase64Url(value: unknown, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    (value.length > 0 && !BASE64URL_PATTERN.test(value))
  ) {
    throw new JifengSecretError();
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new JifengSecretError();
  }
  return decoded;
}

export function parseJifengEncryptionKey(
  encodedKey = process.env.JIFENG_TOKEN_ENCRYPTION_KEY,
): Buffer {
  const encoding = BASE64URL_KEY_PATTERN.test(encodedKey ?? "")
    ? "base64url"
    : BASE64_KEY_PATTERN.test(encodedKey ?? "")
      ? "base64"
      : undefined;
  if (!encodedKey || !encoding) {
    throw new JifengSecretError();
  }

  const key = Buffer.from(encodedKey, encoding);
  validateKey(key);
  return key;
}

export function encryptJifengSecret(
  plaintext: string,
  key: Buffer,
): EncryptedSecret {
  validateKey(key);

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);

    return {
      version: 1,
      ciphertext: ciphertext.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  } catch {
    throw new JifengSecretError();
  }
}

export function decryptJifengSecret(
  envelope: EncryptedSecret,
  key: Buffer,
): string {
  validateKey(key);

  try {
    if (envelope?.version !== 1) {
      throw new JifengSecretError();
    }

    const iv = decodeBase64Url(envelope.iv);
    const tag = decodeBase64Url(envelope.tag);
    const ciphertext = decodeBase64Url(envelope.ciphertext, true);
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
      throw new JifengSecretError();
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new JifengSecretError();
  }
}
