import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("production compose integration rollout", () => {
  const compose = readFileSync(
    resolve(process.cwd(), "compose.production.yaml"),
    "utf8",
  );
  const normalizedCompose = compose.replace(/\r\n/g, "\n");

  it("keeps unconfigured Jifeng optional while Feishu remote writes stay disabled", () => {
    expect(normalizedCompose).not.toMatch(/JIFENG_[A-Z_]+:\s*\$\{[^}]+:\?/);
    expect(normalizedCompose).toContain('FEISHU_CARGO_WRITES_ENABLED: "false"');
  });

  it("initializes the shared worker heartbeat volume before web and worker run as uid 1001", () => {
    expect(normalizedCompose).toMatch(/worker-health-init:\n(?:.*\n)*?\s+user:\s*"0:0"/);
    expect(normalizedCompose).not.toContain("  worker-health-init:\n    <<: *app");
    expect(normalizedCompose).toMatch(/worker-health-init:\n(?:.*\n)*?\s+network_mode:\s+none/);
    expect(normalizedCompose).not.toMatch(/worker-health-init:\n(?:.*\n)*?\s+env_file:/);
    expect(normalizedCompose).toMatch(/worker-health-init:\n(?:.*\n)*?\s+cap_add:\n(?:.*\n)*?\s+- CHOWN/);
    expect(normalizedCompose).toMatch(/worker-health-init:\n(?:.*\n)*?\s+cap_add:\n(?:.*\n)*?\s+- FOWNER/);
    expect(normalizedCompose).toContain(
      "chown -R 1001:1001 /app/runtime/worker-health",
    );
    expect(normalizedCompose).toContain(
      "chmod 0770 /app/runtime/worker-health",
    );
    expect(normalizedCompose).toContain(
      "      - worker_health:/app/runtime/worker-health",
    );
    expect(normalizedCompose).toContain(
      "      worker-health-init:\n        condition: service_completed_successfully",
    );
    expect(normalizedCompose).toContain(
      "  worker:\n    <<: *app\n    command: [\"npm\", \"run\", \"worker\"]\n    depends_on:\n      postgres:\n        condition: service_healthy\n      worker-health-init:\n        condition: service_completed_successfully",
    );
  });
});
