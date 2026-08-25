import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("production backup automation", () => {
  const shellScriptPath = resolve(process.cwd(), "scripts/backup-production.sh");
  const shellScript = readFileSync(shellScriptPath, "utf8");
  const backupPsScript = readFileSync(
    resolve(process.cwd(), "scripts/backup-postgres.ps1"),
    "utf8",
  );
  const restorePsScript = readFileSync(
    resolve(process.cwd(), "scripts/restore-postgres.ps1"),
    "utf8",
  );
  const serviceUnit = readFileSync(
    resolve(process.cwd(), "deploy/systemd/tongzhouxing-shop-backup.service"),
    "utf8",
  );
  const timerUnit = readFileSync(
    resolve(process.cwd(), "deploy/systemd/tongzhouxing-shop-backup.timer"),
    "utf8",
  );

  it("forces backup shell and systemd units to LF in repository exports", () => {
    const result = spawnSync(
      "git",
      [
        "check-attr",
        "text",
        "eol",
        "--",
        "scripts/backup-production.sh",
        "deploy/systemd/tongzhouxing-shop-backup.service",
        "deploy/systemd/tongzhouxing-shop-backup.timer",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("scripts/backup-production.sh: text: set");
    expect(result.stdout).toContain("scripts/backup-production.sh: eol: lf");
    expect(result.stdout).toContain("deploy/systemd/tongzhouxing-shop-backup.service: text: set");
    expect(result.stdout).toContain("deploy/systemd/tongzhouxing-shop-backup.timer: text: set");
  });

  it("backs up postgres and catalog assets through compose env wiring without hard-coded database users", () => {
    expect(shellScript).toContain('docker compose --env-file "$compose_env_file" -f "$compose_file"');
    expect(shellScript).toContain('compose exec -T postgres printenv POSTGRES_USER');
    expect(shellScript).toContain('compose exec -T postgres printenv POSTGRES_DB');
    expect(shellScript).toContain('docker volume inspect "$catalog_assets_volume"');
    expect(shellScript).toContain('docker inspect --format \'{{.Config.Image}}\'');
    expect(shellScript).toContain('APP_VERSION and RELEASE_SHA are required');
    expect(shellScript).toContain('pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"');
    expect(shellScript).toContain('docker run --rm');
    expect(shellScript).toContain("--network none");
    expect(shellScript).toContain('-v "$catalog_assets_volume:/from:ro"');
    expect(shellScript).toContain('sha256sum "$db_name"');
    expect(shellScript).toContain('sha256sum "$assets_name"');
    expect(shellScript).toContain('touch "$staging_dir/.complete"');
    expect(shellScript).toContain('mv "$staging_dir" "$published_dir"');
    expect(shellScript).toContain('-mtime +"$retention_days"');
    expect(backupPsScript).toContain("printenv POSTGRES_USER");
    expect(backupPsScript).toContain('$checksum  $fileName');
    expect(restorePsScript).toContain("printenv POSTGRES_USER");
    expect(restorePsScript).toContain('^(?<hash>[0-9a-fA-F]{64})(?:\\s+\\*?(?<file>.+))?$');
    expect(restorePsScript).toContain("Backup checksum file does not match backup file name");
    expect(backupPsScript).not.toContain("-U tongzhouxing");
    expect(restorePsScript).not.toContain("-U tongzhouxing");
  });

  it("ships installable systemd units for daily backups", () => {
    expect(serviceUnit).toContain("EnvironmentFile=/etc/tongzhouxing-shop/backup.env");
    expect(serviceUnit).toContain("ExecStart=/usr/local/lib/tongzhouxing-shop/backup-production.sh");
    expect(serviceUnit).toContain("UMask=0077");
    expect(serviceUnit).toContain("PrivateTmp=yes");
    expect(serviceUnit).toContain("ProtectHome=read-only");
    expect(timerUnit).toContain("OnCalendar=*-*-* 03:20:00 Asia/Shanghai");
    expect(timerUnit).toContain("Persistent=true");
  });

  it("rejects mutable or mismatched release identifiers before reading production files", () => {
    const shell =
      process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\sh.exe" : "sh";
    const shellPath =
      process.platform === "win32"
        ? `/${shellScriptPath[0].toLowerCase()}${shellScriptPath
            .slice(2)
            .replaceAll("\\", "/")}`
        : shellScriptPath;
    const result = spawnSync(
      shell,
      [shellPath, "missing-compose.yaml", "missing.env", "missing-backups"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APP_VERSION: "latest",
          RELEASE_SHA: "abcdef0123456789abcdef0123456789abcdef01",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "APP_VERSION must be a 7-40 character lowercase Git SHA",
    );
  });

  it("creates both backup artifacts and checksums in one run", () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-automation-"));
    try {
      const fakeDocker = join(directory, "docker");
      const composeFile = join(directory, "compose.yaml");
      const composeEnvFile = join(directory, "production.env");
      const backupDir = join(directory, "backups");
      const containerDirectory = join(directory, "container");
      const dockerLog = join(directory, "docker.log");
      const toShellPath = (path: string) =>
        process.platform === "win32"
          ? `/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`
          : path;

      writeFileSync(composeFile, "services: {}\n", "utf8");
      writeFileSync(composeEnvFile, "SAFE_PLACEHOLDER=1\n", "utf8");
      writeFileSync(
        fakeDocker,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "compose" ]; then
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file|-f)
        shift 2
        ;;
      ps)
        shift
        if [ "$1" = "-q" ] && [ "$2" = "postgres" ]; then
          printf '%s\\n' 'postgres-container'
          exit 0
        fi
        ;;
      exec)
        shift
        [ "$1" = "-T" ] || exit 9
        shift
        [ "$1" = "postgres" ] || exit 9
        shift
        if [ "$1" = "printenv" ] && [ "$2" = "POSTGRES_USER" ]; then
          printf '%s\\n' 'produser'
          exit 0
        fi
        if [ "$1" = "printenv" ] && [ "$2" = "POSTGRES_DB" ]; then
          printf '%s\\n' 'proddb'
          exit 0
        fi
        if [ "$1" = "sh" ] && [ "$2" = "-lc" ]; then
          backup_file=$5
          mkdir -p "$(dirname "$FAKE_CONTAINER_ROOT$backup_file")"
          printf '%s' 'db-backup' > "$FAKE_CONTAINER_ROOT$backup_file"
          exit 0
        fi
        if [ "$1" = "rm" ] && [ "$2" = "-f" ]; then
          rm -f "$FAKE_CONTAINER_ROOT$3"
          exit 0
        fi
        ;;
    esac
  done
fi
if [ "$1" = "cp" ]; then
  src=$2
  target=$3
  source_path=${"${"}src#postgres-container:}
  cp "$FAKE_CONTAINER_ROOT$source_path" "$target"
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf '%s\n' 'postgres:18-alpine'
  exit 0
fi
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  if [ "${"${"}FAKE_DOCKER_MISSING_VOLUME:-}" = "1" ]; then
    exit 17
  fi
  printf '%s\n' 'catalog-assets-volume'
  exit 0
fi
if [ "$1" = "run" ]; then
  assets_file=$(printf '%s' "$*" | sed -n 's|.*tar -czf "/to/\\([^"]*\\)".*|\\1|p')
  to_directory=
  for argument in "$@"; do
    case "$argument" in
      *:/to)
        to_directory=${"${"}argument%:/to}
        ;;
    esac
  done
  [ -n "$to_directory" ] || exit 9
  if [ "${"${"}FAKE_DOCKER_FAIL_ASSETS:-}" = "1" ]; then
    printf '%s' 'partial-assets-backup' > "$to_directory/$assets_file"
    exit 19
  fi
  printf '%s' 'assets-backup' > "$to_directory/$assets_file"
  exit 0
fi
exit 9
`,
        "utf8",
      );
      chmodSync(fakeDocker, 0o755);

      const shell =
        process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\sh.exe" : "sh";
      const result = spawnSync(
        shell,
        [
          toShellPath(shellScriptPath),
          toShellPath(composeFile),
          toShellPath(composeEnvFile),
          toShellPath(backupDir),
          "30",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_BACKUP_DIR: toShellPath(backupDir),
            FAKE_CONTAINER_ROOT: toShellPath(containerDirectory),
            FAKE_DOCKER_LOG: toShellPath(dockerLog),
            APP_VERSION: "abcdef0",
            RELEASE_SHA: "abcdef0123456789abcdef0123456789abcdef01",
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const created = readdirSync(backupDir).sort();
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^backup-set-\d{8}T\d{6}Z$/);
      const publishedSet = readdirSync(join(backupDir, created[0])).sort();
      expect(publishedSet).toContain(".complete");
      expect(publishedSet.some((entry) => entry.startsWith("tongzhouxing-proddb-") && entry.endsWith(".dump"))).toBe(true);
      expect(publishedSet.some((entry) => entry.startsWith("tongzhouxing-proddb-") && entry.endsWith(".dump.sha256"))).toBe(true);
      expect(publishedSet.some((entry) => entry.startsWith("tongzhouxing-catalog-assets-") && entry.endsWith(".tar.gz"))).toBe(true);
      expect(publishedSet.some((entry) => entry.startsWith("tongzhouxing-catalog-assets-") && entry.endsWith(".tar.gz.sha256"))).toBe(true);
      expect(result.stdout).toContain(".dump");
      expect(result.stdout).toContain(".tar.gz");
      const commands = readFileSync(dockerLog, "utf8");
      expect(commands).toContain("compose --env-file");
      expect(commands).toContain("printenv POSTGRES_USER");
      expect(commands).toContain("printenv POSTGRES_DB");
      expect(commands).toContain("run --rm");

      const failedBackupDir = join(directory, "failed-backups");
      const failedResult = spawnSync(
        shell,
        [
          toShellPath(shellScriptPath),
          toShellPath(composeFile),
          toShellPath(composeEnvFile),
          toShellPath(failedBackupDir),
          "30",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_BACKUP_DIR: toShellPath(failedBackupDir),
            FAKE_CONTAINER_ROOT: toShellPath(containerDirectory),
            FAKE_DOCKER_FAIL_ASSETS: "1",
            FAKE_DOCKER_LOG: toShellPath(dockerLog),
            APP_VERSION: "abcdef0",
            RELEASE_SHA: "abcdef0123456789abcdef0123456789abcdef01",
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(failedResult.status).not.toBe(0);
      expect(readdirSync(failedBackupDir)).toEqual([]);

      const missingVolumeDir = join(directory, "missing-volume-backups");
      const missingVolumeResult = spawnSync(
        shell,
        [
          toShellPath(shellScriptPath),
          toShellPath(composeFile),
          toShellPath(composeEnvFile),
          toShellPath(missingVolumeDir),
          "30",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_BACKUP_DIR: toShellPath(missingVolumeDir),
            FAKE_CONTAINER_ROOT: toShellPath(containerDirectory),
            FAKE_DOCKER_LOG: toShellPath(dockerLog),
            FAKE_DOCKER_MISSING_VOLUME: "1",
            APP_VERSION: "abcdef0",
            RELEASE_SHA: "abcdef0123456789abcdef0123456789abcdef01",
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(missingVolumeResult.status).not.toBe(0);
      expect(readdirSync(missingVolumeDir)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);
});
