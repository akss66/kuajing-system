import { describe, expect, test } from "vitest";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import nextConfig from "../../../next.config";

describe("Next.js Server Actions upload capacity", () => {
  test("accepts one store group's ten 10 MB files plus form-data overhead", () => {
    expect(nextConfig.experimental?.serverActions).toMatchObject({
      bodySizeLimit: "101mb",
    });
  });

  test("keeps the worktree and linked node_modules inside Turbopack's filesystem root", () => {
    const root = nextConfig.turbopack?.root;
    expect(root).toEqual(expect.any(String));
    if (!root) throw new Error("Turbopack root is required");

    for (const target of [
      resolve(process.cwd()),
      realpathSync.native(resolve(process.cwd(), "node_modules")),
    ]) {
      const child = relative(root, target);
      expect(child === "" || (!child.startsWith("..") && !child.startsWith("/"))).toBe(true);
    }
  });
});
