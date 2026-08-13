import { execFileSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url);
const runId = `task5-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
const imageTag = `tongzhouxing-shop:${runId}`;
const volumeName = `task5_catalog_assets_${runId}`;

function runDocker(args, options = {}) {
  const output = execFileSync("docker", args, {
    cwd: new URL(".", repoRoot),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
}

try {
  runDocker(["version", "--format", "{{.Server.Version}}"]);
} catch (error) {
  const detail =
    error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : String(error);
  console.error(`Docker is unavailable: ${detail}`);
  process.exit(1);
}

try {
  console.log(`Building runtime image ${imageTag}...`);
  runDocker(["build", "-t", imageTag, "-f", "Dockerfile", "."], { stdio: "inherit" });

  console.log(`Creating temporary volume ${volumeName}...`);
  runDocker(["volume", "create", volumeName], { stdio: "inherit" });

  const mount = `${volumeName}:/app/data/catalog-assets`;
  const writerScript = [
    "set -eu",
    "test -w /app/data/catalog-assets",
    "printf 'writer' > /app/data/catalog-assets/probe.txt",
    "stat -c '%u:%g %A' /app/data/catalog-assets",
    "stat -c '%u:%g %A' /app/data/catalog-assets/probe.txt",
  ].join("; ");
  const readerScript = [
    "set -eu",
    "test -r /app/data/catalog-assets/probe.txt",
    "grep -q '^writer$' /app/data/catalog-assets/probe.txt",
    "printf 'worker' >> /app/data/catalog-assets/probe.txt",
    "grep -q '^writerworker$' /app/data/catalog-assets/probe.txt",
    "stat -c '%u:%g %A' /app/data/catalog-assets/probe.txt",
  ].join("; ");

  console.log("Verifying writer access as uid 1001...");
  runDocker(
    [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "--user",
      "1001:1001",
      "-v",
      mount,
      imageTag,
      "-lc",
      writerScript,
    ],
    { stdio: "inherit" },
  );

  console.log("Verifying second container can read and append the same file...");
  runDocker(
    [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      "--user",
      "1001:1001",
      "-v",
      mount,
      imageTag,
      "-lc",
      readerScript,
    ],
    { stdio: "inherit" },
  );

  console.log("Catalog asset volume permission check passed.");
} finally {
  try {
    runDocker(["volume", "rm", "-f", volumeName], { stdio: "inherit" });
  } catch {}

  try {
    runDocker(["image", "rm", "-f", imageTag], { stdio: "inherit" });
  } catch {}
}
