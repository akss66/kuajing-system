import { afterEach, describe, expect, it, vi } from "vitest";

const { getRuntimeHealth } = vi.hoisted(() => ({
  getRuntimeHealth: vi.fn(),
}));

vi.mock("@/modules/system/health", () => ({ getRuntimeHealth }));

import { GET } from "@/app/api/health/route";

describe("public health release identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    getRuntimeHealth.mockReset();
  });

  it("returns bounded component health and immutable release identity", async () => {
    vi.stubEnv("APP_VERSION", "67755f4");
    vi.stubEnv("RELEASE_SHA", "67755f408db4e203dc6e8fc04d00b74ec61cc60d");
    vi.stubEnv("JIFENG_CLIENT_SECRET", "must-never-leak");
    getRuntimeHealth.mockResolvedValueOnce({
      database: "healthy",
      status: "ok",
      worker: "healthy",
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      components: {
        database: "healthy",
        worker: "healthy",
      },
      revision: "67755f408db4e203dc6e8fc04d00b74ec61cc60d",
      status: "ok",
      version: "67755f4",
    });
  });

  it.each(["missing", "stale"] as const)(
    "reports a %s worker as degraded without making the web readiness probe fail",
    async (worker) => {
      getRuntimeHealth.mockResolvedValueOnce({
        database: "healthy",
        status: "degraded",
        worker,
      });

      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        components: { database: "healthy", worker },
        status: "degraded",
      });
    },
  );

  it("keeps release identity visible when the database is unavailable", async () => {
    vi.stubEnv("APP_VERSION", "67755f4");
    vi.stubEnv("RELEASE_SHA", "67755f408db4e203dc6e8fc04d00b74ec61cc60d");
    getRuntimeHealth.mockRejectedValueOnce(new Error("database unavailable at /secret/path"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      components: {
        database: "unavailable",
        worker: "unknown",
      },
      revision: "67755f408db4e203dc6e8fc04d00b74ec61cc60d",
      status: "unavailable",
      version: "67755f4",
    });
  });
});
