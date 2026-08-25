import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("customer portal motion system", () => {
  it("keeps route navigation stable while preserving local interaction feedback", () => {
    const globalsSource = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const shellSource = readFileSync(
      join(process.cwd(), "src/components/layout/merchant-shell-frame.tsx"),
      "utf8",
    );

    expect(globalsSource).toContain("--motion-enter");
    expect(globalsSource).toContain("--ease-portal-out");
    expect(globalsSource).not.toContain("@keyframes portal-content-focus");
    expect(globalsSource).not.toContain(".customer-surface-enter");
    expect(shellSource).not.toContain("customer-surface-enter");
    expect(
      existsSync(join(process.cwd(), "src/app/(customer)/portal/loading.tsx")),
    ).toBe(false);
    expect(globalsSource).toContain("@keyframes portal-navigation-settle");
    expect(globalsSource).toContain("@keyframes portal-file-ready");
    expect(globalsSource).toContain("prefers-reduced-motion: reduce");
  });
});
