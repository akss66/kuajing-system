import { describe, expect, test } from "vitest";

import nextConfig from "../../../next.config";

describe("Next.js Server Actions upload capacity", () => {
  test("accepts one store group's ten 10 MB files plus form-data overhead", () => {
    expect(nextConfig.experimental?.serverActions).toMatchObject({
      bodySizeLimit: "101mb",
    });
  });
});
