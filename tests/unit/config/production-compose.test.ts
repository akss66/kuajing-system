import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("production compose integration rollout", () => {
  const compose = readFileSync(
    resolve(process.cwd(), "compose.production.yaml"),
    "utf8",
  );

  it("keeps unconfigured Jifeng optional while Feishu remote writes stay disabled", () => {
    expect(compose).not.toMatch(/JIFENG_[A-Z_]+:\s*\$\{[^}]+:\?/);
    expect(compose).toContain('FEISHU_CARGO_WRITES_ENABLED: "false"');
  });
});
