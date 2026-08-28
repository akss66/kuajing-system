import { describe, expect, it } from "vitest";

import {
  decryptPii,
  encryptPii,
  parsePiiEncryptionKey,
} from "@/shared/pii-crypto";

const key = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 8).toString("base64");

describe("PII encryption", () => {
  it("round-trips structured recipient data without placing plaintext in storage", () => {
    const recipient = {
      name: "匿名收件人",
      phone: "+1 613 555 0100",
      address: "100 Example Street, Ottawa, ON",
    };

    const encrypted = encryptPii(recipient, parsePiiEncryptionKey(key));

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain(recipient.name);
    expect(encrypted).not.toContain(recipient.phone);
    expect(encrypted).not.toContain(recipient.address);
    expect(
      decryptPii<typeof recipient>(encrypted, parsePiiEncryptionKey(key)),
    ).toEqual(recipient);
  });

  it("rejects the wrong key with a generic error that never leaks recipient data", () => {
    const recipient = {
      name: "敏感姓名",
      phone: "+1 613 555 0199",
      address: "200 Private Avenue",
    };
    const encrypted = encryptPii(recipient, parsePiiEncryptionKey(key));

    let message = "";
    try {
      decryptPii(encrypted, parsePiiEncryptionKey(otherKey));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("无法解密敏感信息");
    expect(message).not.toContain(recipient.name);
    expect(message).not.toContain(recipient.phone);
    expect(message).not.toContain(recipient.address);
  });

  it("requires an exact 32-byte base64 environment key", () => {
    expect(() => parsePiiEncryptionKey("")).toThrow(
      "PII_ENCRYPTION_KEY 未配置",
    );
    expect(() => parsePiiEncryptionKey("not-base64")).toThrow(
      "PII_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥",
    );
    expect(() => parsePiiEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(
      "PII_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥",
    );
  });
});
