import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("approved brand asset", () => {
  it("preserves the source dimensions and alpha channel", async () => {
    const png = await readFile(
      path.join(process.cwd(), "public/brand/tongzhouxing-logo.png"),
    );

    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(683);
    expect(png.readUInt32BE(20)).toBe(656);
    expect([4, 6]).toContain(png.readUInt8(25));
  });
});
