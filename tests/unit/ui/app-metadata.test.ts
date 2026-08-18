import { describe, expect, it } from "vitest";

import { metadata } from "@/app/layout";
import { BRAND } from "@/shared/brand";

describe("application metadata", () => {
  it("uses the approved system logo for browser and device icons", () => {
    expect(metadata.icons).toEqual({
      apple: BRAND.logoPath,
      icon: BRAND.logoPath,
      shortcut: BRAND.logoPath,
    });
  });
});
