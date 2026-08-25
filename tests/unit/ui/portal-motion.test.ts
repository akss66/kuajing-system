import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("customer portal motion system", () => {
  it("uses bounded motion tokens with deliberate portal feedback", () => {
    const globalsSource = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

    expect(globalsSource).toContain("--motion-enter");
    expect(globalsSource).toContain("--ease-portal-out");
    expect(globalsSource).toContain("@keyframes portal-content-focus");
    expect(globalsSource).toContain("@keyframes portal-navigation-settle");
    expect(globalsSource).toContain("@keyframes portal-file-ready");
    expect(globalsSource).toContain("prefers-reduced-motion: reduce");
  });
});
