import { describe, expect, test } from "vitest";

import {
  decryptJifengSecret,
  encryptJifengSecret,
  JifengSecretError,
  parseJifengEncryptionKey,
} from "@/modules/jifeng-connection/crypto";

const key = Buffer.alloc(32, 17);
const otherKey = Buffer.alloc(32, 23);

function tamper(value: string) {
  const first = value[0] === "A" ? "B" : "A";
  return `${first}${value.slice(1)}`;
}

function captureError(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}

describe("Jifeng secret encryption", () => {
  test("uses an independent IV and ciphertext for every encryption", () => {
    const plaintext = "oauth-access-token";

    const first = encryptJifengSecret(plaintext, key);
    const second = encryptJifengSecret(plaintext, key);

    expect(first).toMatchObject({ version: 1 });
    expect(Buffer.from(first.iv, "base64url")).toHaveLength(12);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain(plaintext);
  });

  test("decrypts an authenticated envelope with the matching key", () => {
    const plaintext = "oauth-refresh-token";

    const envelope = encryptJifengSecret(plaintext, key);

    expect(decryptJifengSecret(envelope, key)).toBe(plaintext);
  });

  test("rejects the wrong key without leaking sensitive values", () => {
    const plaintext = "private-oauth-token";
    const envelope = encryptJifengSecret(plaintext, key);

    const error = captureError(() => decryptJifengSecret(envelope, otherKey));

    expect(error).toBeInstanceOf(JifengSecretError);
    expect((error as Error).message).not.toContain(plaintext);
    expect((error as Error).message).not.toContain(key.toString("base64url"));
    expect((error as Error).message).not.toContain(envelope.ciphertext);
  });

  test.each(["ciphertext", "tag"] as const)(
    "rejects a tampered %s",
    (field) => {
      const envelope = encryptJifengSecret("authenticated-token", key);
      const tampered = { ...envelope, [field]: tamper(envelope[field]) };

      expect(() => decryptJifengSecret(tampered, key)).toThrowError(
        JifengSecretError,
      );
    },
  );

  test("rejects an unknown envelope version", () => {
    const envelope = {
      ...encryptJifengSecret("versioned-token", key),
      version: 2,
    };

    expect(() =>
      decryptJifengSecret(
        envelope as Parameters<typeof decryptJifengSecret>[0],
        key,
      ),
    ).toThrowError(JifengSecretError);
  });

  test("accepts only an environment key that decodes to exactly 32 bytes", () => {
    expect(parseJifengEncryptionKey(key.toString("base64url"))).toEqual(key);
    expect(parseJifengEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(() => parseJifengEncryptionKey(undefined)).toThrowError(
      JifengSecretError,
    );
    expect(() => parseJifengEncryptionKey("not-base64url!"))
      .toThrowError(JifengSecretError);
    expect(() =>
      parseJifengEncryptionKey(Buffer.alloc(31).toString("base64url")),
    ).toThrowError(JifengSecretError);
  });
});
