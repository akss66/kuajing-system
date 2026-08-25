import { describe, expect, it } from "vitest";

import { validateReleaseMetadata } from "../../../scripts/verify-release-metadata";

describe("immutable production release metadata", () => {
  const releaseSha = "c81453f115d38671326ca7bbeb986bc1f0d71e32";

  it("accepts a short image SHA tied to the full release SHA", () => {
    expect(
      validateReleaseMetadata({
        appVersion: "c81453f",
        packageVersion: "0.2.0",
        releaseSha,
      }),
    ).toEqual({
      appVersion: "c81453f",
      packageVersion: "0.2.0",
      releaseSha,
    });
  });

  it.each(["", "current", "latest", "0.2.0", "feature/order"])(
    "rejects movable or non-SHA APP_VERSION %j",
    (appVersion) => {
      expect(() =>
        validateReleaseMetadata({
          appVersion,
          packageVersion: "0.2.0",
          releaseSha,
        }),
      ).toThrow(/APP_VERSION/);
    },
  );

  it("rejects metadata from different commits", () => {
    expect(() =>
      validateReleaseMetadata({
        appVersion: "deadbee",
        packageVersion: "0.2.0",
        releaseSha,
      }),
    ).toThrow(/same commit/);
  });
});
