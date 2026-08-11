import { describe, expect, it } from "vitest";

import { BRAND, BUSINESS_TIME_ZONE } from "@/shared/brand";

describe("brand configuration", () => {
  it("uses the approved name, logo and Ottawa business timezone", () => {
    expect(BRAND).toEqual({
      name: "同舟行跨境",
      logoPath: "/brand/tongzhouxing-logo.png",
    });
    expect(BUSINESS_TIME_ZONE).toBe("America/Toronto");
  });
});
