import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { resolveModuleRelativePath } from "@/modules/feishu/asset-coordination";

class TurbopackUrlWrapper {
  constructor(public readonly href: string) {}
}

describe("asset coordination", () => {
  test("resolves module-relative paths from Turbopack-style URL wrappers", () => {
    const moduleUrl = new TurbopackUrlWrapper(
      pathToFileURL(resolve("src/modules/feishu/asset-coordination.ts")).href,
    );

    expect(resolveModuleRelativePath("../../db/client.ts", moduleUrl)).toBe(
      resolve("src/db/client.ts"),
    );
  });
});
