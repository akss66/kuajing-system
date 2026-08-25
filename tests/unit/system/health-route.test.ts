import { afterEach, describe, expect, it, vi } from "vitest";

const { checkDatabaseHealth } = vi.hoisted(() => ({
  checkDatabaseHealth: vi.fn(),
}));

vi.mock("@/modules/system/health", () => ({ checkDatabaseHealth }));

import { GET } from "@/app/api/health/route";

describe("public health release identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    checkDatabaseHealth.mockReset();
  });

  it("returns only health and immutable release identity", async () => {
    vi.stubEnv("APP_VERSION", "67755f4");
    vi.stubEnv("RELEASE_SHA", "67755f408db4e203dc6e8fc04d00b74ec61cc60d");
    vi.stubEnv("JIFENG_CLIENT_SECRET", "must-never-leak");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: "67755f408db4e203dc6e8fc04d00b74ec61cc60d",
      status: "ok",
      version: "67755f4",
    });
  });

  it("keeps release identity visible when dependencies are unavailable", async () => {
    vi.stubEnv("APP_VERSION", "67755f4");
    vi.stubEnv("RELEASE_SHA", "67755f408db4e203dc6e8fc04d00b74ec61cc60d");
    checkDatabaseHealth.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      revision: "67755f408db4e203dc6e8fc04d00b74ec61cc60d",
      status: "unavailable",
      version: "67755f4",
    });
  });
});
