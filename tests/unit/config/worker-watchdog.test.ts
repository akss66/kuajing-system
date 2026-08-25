import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("production worker watchdog", () => {
  const script = readFileSync(
    resolve(process.cwd(), "scripts/worker-watchdog.sh"),
    "utf8",
  );

  it("only recreates the unhealthy worker without touching web or postgres", () => {
    expect(script).toContain("unhealthy)");
    expect(script).toContain("--no-build --no-deps --force-recreate worker");
    expect(script).not.toMatch(/force-recreate (?:postgres|web)/);
    expect(script).not.toMatch(/(?:restart|stop|down) (?:postgres|web)/);
    expect(script).toContain('replacement_id" = "$container_id');
    expect(script).toContain("worker recreation did not produce a new container");
  });

  it("does not recreate missing, starting or unexpectedly unhealthy-shaped services", () => {
    expect(script).toContain("healthy|starting)");
    expect(script).toContain("worker container is missing; no automatic action taken");
    expect(script).toContain("unexpected worker health '$health'; no automatic action taken");
  });

  it("overrides any stale compose env-file tag with one validated release identity", () => {
    expect(script).toContain("export APP_VERSION RELEASE_SHA");
    expect(script).toContain("APP_VERSION must be a 7-40 character lowercase Git SHA");
    expect(script).toContain("RELEASE_SHA must be a full 40 character lowercase Git SHA");
    expect(script).toContain("APP_VERSION and RELEASE_SHA identify different commits");
  });
});
