import { spawn } from "node:child_process";
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { TemporaryAssetManifest } from "@/modules/feishu/cargo-types";
import {
  createCatalogAssetStorage,
  commitCatalogAsset,
  discardStagedAssets,
  openCatalogAsset,
  stageCatalogAsset,
} from "@/modules/feishu/asset-storage";

const ONE_MEBIBYTE = 1024 * 1024;
const MAX_FILE_BYTES = 8 * ONE_MEBIBYTE;
let assetRoot: string;

function createStagingTempFileName(input: { createdAtMs: number; ownerToken: string }) {
  return `.catalog-asset-stage-${input.createdAtMs}-${input.ownerToken}.tmp`;
}

async function waitForCondition(
  condition: () => boolean,
  input?: { intervalMs?: number; timeoutMs?: number },
) {
  const startedAt = Date.now();
  const intervalMs = input?.intervalMs ?? 5;
  const timeoutMs = input?.timeoutMs ?? 1_000;
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function createImageBuffer(
  format: "jpeg" | "png" | "webp",
  input?: { b?: number; g?: number; height?: number; r?: number; width?: number },
) {
  const width = input?.width ?? 12;
  const height = input?.height ?? 8;
  const image = sharp({
    create: {
      background: {
        alpha: 1,
        b: input?.b ?? 91,
        g: input?.g ?? 72,
        r: input?.r ?? 48,
      },
      channels: 4,
      height,
      width,
    },
  });

  if (format === "jpeg") {
    return image.jpeg({ mozjpeg: true }).toBuffer();
  }

  if (format === "webp") {
    return image.webp().toBuffer();
  }

  return image.png().toBuffer();
}

function stagedRunDirectory(manifest: TemporaryAssetManifest) {
  return join(assetRoot, dirname(manifest.temporaryKey));
}

function unsupportedLinkError() {
  const error = new Error("hard links are not supported on this volume") as NodeJS.ErrnoException;
  error.code = "ENOTSUP";
  return error;
}

async function sumDirectoryBytes(directoryPath: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const absolutePath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      total += await sumDirectoryBytes(absolutePath);
      continue;
    }
    if (entry.isFile()) {
      total += (await stat(absolutePath)).size;
    }
  }
  return total;
}

async function runStageInChildProcess(input: {
  assetDir: string;
  bytesPath: string;
  maxRunBytes: number;
  originalFileName: string;
  runId: string;
  skuCode: string;
}) {
  const scriptPath = join(input.assetDir, `stage-worker-${crypto.randomUUID()}.mjs`);
  const storageModuleUrl = pathToFileURL(
    join(process.cwd(), "src/modules/feishu/asset-storage.ts"),
  ).href;
  await writeFile(
    scriptPath,
    `
import { readFile } from "node:fs/promises";
import { createCatalogAssetStorage } from ${JSON.stringify(storageModuleUrl)};

const storage = createCatalogAssetStorage({
  lockRetryDelayMs: 10,
  lockStaleMs: 5_000,
  lockTimeoutMs: 5_000,
  maxRunBytes: Number(process.env.TEST_MAX_RUN_BYTES),
});

try {
  const bytes = await readFile(process.env.TEST_BYTES_PATH);
  const manifest = await storage.stageCatalogAsset({
    bytes,
    contentType: "image/png",
    originalFileName: process.env.TEST_ORIGINAL_FILE_NAME,
    runId: process.env.TEST_RUN_ID,
    skuCode: process.env.TEST_SKU_CODE,
  });
  process.stdout.write(JSON.stringify({ ok: true, temporaryKey: manifest.temporaryKey }));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
`,
  );

  return await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CATALOG_ASSET_DIR: input.assetDir,
          TEST_BYTES_PATH: input.bytesPath,
          TEST_MAX_RUN_BYTES: String(input.maxRunBytes),
          TEST_ORIGINAL_FILE_NAME: input.originalFileName,
          TEST_RUN_ID: input.runId,
          TEST_SKU_CODE: input.skuCode,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

beforeEach(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "catalog-assets-"));
  process.env.CATALOG_ASSET_DIR = assetRoot;
});

afterEach(async () => {
  delete process.env.CATALOG_ASSET_DIR;
  await rm(assetRoot, { force: true, recursive: true });
});

describe("catalog asset storage", () => {
  test.each([
    { extension: "jpg", format: "jpeg", mimeType: "image/jpeg" as const },
    { extension: "png", format: "png", mimeType: "image/png" as const },
    { extension: "webp", format: "webp", mimeType: "image/webp" as const },
  ] as const)(
    "accepts real $mimeType bytes, deduplicates content, and opens committed assets",
    async ({ extension, format, mimeType }) => {
      const bytes = await createImageBuffer(format);

      const staged = await stageCatalogAsset({
        bytes,
        contentType: mimeType,
        originalFileName: `fixture.${extension}`,
        runId: "run-a",
        skuCode: "TZX-001",
      });
      const duplicateStage = await stageCatalogAsset({
        bytes,
        contentType: mimeType,
        originalFileName: `duplicate.${extension}`,
        runId: "run-a",
        skuCode: "TZX-001",
      });

      expect(staged.mimeType).toBe(mimeType);
      expect(staged.byteSize).toBe(bytes.byteLength);
      expect(staged.originalFileName).toBe(`fixture.${extension}`);
      expect(staged.temporaryKey).toMatch(
        new RegExp(`^temporary/run-a/[0-9a-f]{64}\\.${extension}$`),
      );
      expect(duplicateStage.temporaryKey).toBe(staged.temporaryKey);

      const stagedFiles = await readdir(stagedRunDirectory(staged));
      expect(stagedFiles.filter((entry) => entry.endsWith(`.${extension}`))).toHaveLength(1);

      const storageKey = await commitCatalogAsset(staged);
      expect(storageKey).toMatch(
        new RegExp(`^sha256/[0-9a-f]{2}/[0-9a-f]{64}\\.${extension}$`),
      );

      const secondRun = await stageCatalogAsset({
        bytes,
        contentType: mimeType,
        originalFileName: `second-run.${extension}`,
        runId: "run-b",
        skuCode: "TZX-001",
      });
      expect(await commitCatalogAsset(secondRun)).toBe(storageKey);

      const opened = await openCatalogAsset(storageKey);
      expect(opened.contentType).toBe(mimeType);
      expect(Buffer.compare(Buffer.from(opened.bytes), bytes)).toBe(0);

      await expect(readFile(join(assetRoot, staged.temporaryKey))).rejects.toThrow();
      await expect(readFile(join(assetRoot, secondRun.temporaryKey))).rejects.toThrow();
    },
  );

  test("rejects mismatched mime types and unsupported SVG payloads", async () => {
    const png = await createImageBuffer("png");

    await expect(
      stageCatalogAsset({
        bytes: png,
        contentType: "image/jpeg",
        originalFileName: "bad-mime.png",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/content type/i);

    await expect(
      stageCatalogAsset({
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        contentType: "image/svg+xml",
        originalFileName: "vector.svg",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/unsupported/i);
  });

  test("rejects oversized files and images above the pixel limit", async () => {
    await expect(
      stageCatalogAsset({
        bytes: Buffer.alloc(MAX_FILE_BYTES + 1, 7),
        contentType: "image/png",
        originalFileName: "oversized.png",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/8\s*MiB/i);

    const bomb = await createImageBuffer("png", { height: 5000, width: 5001 });
    expect(bomb.byteLength).toBeLessThan(MAX_FILE_BYTES);

    await expect(
      stageCatalogAsset({
        bytes: bomb,
        contentType: "image/png",
        originalFileName: "bomb.png",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/25,?000,?000/i);
  });

  test("rejects traversal in run ids, temporary keys, and storage keys", async () => {
    const png = await createImageBuffer("png");

    await expect(
      stageCatalogAsset({
        bytes: png,
        contentType: "image/png",
        originalFileName: "escape.png",
        runId: "../escape",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/run id/i);

    await expect(
      commitCatalogAsset({
        byteSize: png.byteLength,
        contentSha256: "a".repeat(64),
        mimeType: "image/png",
        originalFileName: "escape.png",
        skuCode: "TZX-001",
        temporaryKey: "../escape.png",
      }),
    ).rejects.toThrow(/temporary/i);

    await expect(openCatalogAsset("../escape.png")).rejects.toThrow(/storage key/i);
  });

  test("keeps traversal-like sku codes out of paths and can discard staged assets", async () => {
    const png = await createImageBuffer("png");
    const manifest = await stageCatalogAsset({
      bytes: png,
      contentType: "image/png",
      originalFileName: "fixture.png",
      runId: "run-a",
      skuCode: "..\\..\\payload",
    });

    expect(manifest.skuCode).toBe("..\\..\\payload");
    expect(manifest.temporaryKey).not.toContain("payload");
    expect(manifest.temporaryKey).not.toContain("..");

    await discardStagedAssets("run-a");
    await expect(readFile(join(assetRoot, manifest.temporaryKey))).rejects.toThrow();
  });

  test("enforces the cumulative 1 GiB per-run limit", async () => {
    const first = await stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 20 }),
      contentType: "image/png",
      originalFileName: "first.png",
      runId: "run-a",
      skuCode: "TZX-001",
    });
    const fillerPath = join(stagedRunDirectory(first), "filler.bin");
    await mkdir(dirname(fillerPath), { recursive: true });
    await writeFile(fillerPath, Buffer.alloc(ONE_MEBIBYTE));
    for (let index = 1; index < 1024; index += 1) {
      await link(fillerPath, join(stagedRunDirectory(first), `filler-${index}.bin`));
    }

    await expect(
      stageCatalogAsset({
        bytes: await createImageBuffer("png", { g: 12 }),
        contentType: "image/png",
        originalFileName: "second.png",
        runId: "run-a",
        skuCode: "TZX-002",
      }),
    ).rejects.toThrow(/1\s*GiB/i);
  });

  test("serializes same-run quota accounting across concurrent processes", async () => {
    const maxRunBytes = 18_000;
    const storage = createCatalogAssetStorage({ maxRunBytes });
    const first = await storage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 20 }),
      contentType: "image/png",
      originalFileName: "first.png",
      runId: "quota-run",
      skuCode: "TZX-001",
    });
    const secondBytes = await createImageBuffer("png", { g: 60 });
    const thirdBytes = await createImageBuffer("png", { r: 90 });
    const fillerSize =
      maxRunBytes - first.byteSize - Math.max(secondBytes.byteLength, thirdBytes.byteLength) - 16;
    await writeFile(join(stagedRunDirectory(first), "filler.bin"), Buffer.alloc(fillerSize));

    const secondBytesPath = join(assetRoot, "second-bytes.png");
    const thirdBytesPath = join(assetRoot, "third-bytes.png");
    await writeFile(secondBytesPath, secondBytes);
    await writeFile(thirdBytesPath, thirdBytes);

    const [second, third] = await Promise.all([
      runStageInChildProcess({
        assetDir: assetRoot,
        bytesPath: secondBytesPath,
        maxRunBytes,
        originalFileName: "second.png",
        runId: "quota-run",
        skuCode: "TZX-002",
      }),
      runStageInChildProcess({
        assetDir: assetRoot,
        bytesPath: thirdBytesPath,
        maxRunBytes,
        originalFileName: "third.png",
        runId: "quota-run",
        skuCode: "TZX-003",
      }),
    ]);

    expect([second.code, third.code].sort()).toEqual([0, 1]);
    expect(`${second.stderr}\n${third.stderr}`).toMatch(/1\s*GiB|limit/i);
    expect(await sumDirectoryBytes(stagedRunDirectory(first))).toBeLessThanOrEqual(maxRunBytes);
  });

  test("reclaims stale staging temp files after a new run-lock owner takes over", async () => {
    const bytes = await createImageBuffer("png", { b: 140 });
    const maxRunBytes = bytes.byteLength + 32;
    const runId = "stale-stage-temp-run";
    const runDirectory = join(assetRoot, "temporary", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(
        runDirectory,
        createStagingTempFileName({
          createdAtMs: Date.now() - 5_000,
          ownerToken: "11111111-1111-1111-1111-111111111111",
        }),
      ),
      Buffer.alloc(maxRunBytes),
    );
    const storage = createCatalogAssetStorage({
      heartbeatIntervalMs: 10,
      lockRetryDelayMs: 5,
      lockStaleMs: 40,
      lockTimeoutMs: 400,
      maxRunBytes,
    });

    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "stale-stage.png",
      runId,
      skuCode: "TZX-001",
    });

    const runEntries = await readdir(runDirectory);
    expect(runEntries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(await sumDirectoryBytes(runDirectory)).toBeLessThanOrEqual(maxRunBytes);
    await expect(readFile(join(assetRoot, manifest.temporaryKey))).resolves.toBeDefined();
  });

  test("does not reclaim fresh staging temp files from another owner", async () => {
    const bytes = await createImageBuffer("png", { g: 145 });
    const maxRunBytes = bytes.byteLength + 32;
    const runId = "fresh-stage-temp-run";
    const runDirectory = join(assetRoot, "temporary", runId);
    const freshTempPath = join(
      runDirectory,
      createStagingTempFileName({
        createdAtMs: Date.now(),
        ownerToken: "22222222-2222-2222-2222-222222222222",
      }),
    );
    await mkdir(runDirectory, { recursive: true });
    await writeFile(freshTempPath, Buffer.alloc(maxRunBytes));
    const storage = createCatalogAssetStorage({
      heartbeatIntervalMs: 10,
      lockRetryDelayMs: 5,
      lockStaleMs: 40,
      lockTimeoutMs: 400,
      maxRunBytes,
    });

    await expect(
      storage.stageCatalogAsset({
        bytes,
        contentType: "image/png",
        originalFileName: "fresh-stage.png",
        runId,
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/1\s*GiB|limit/i);
    await expect(readFile(freshTempPath)).resolves.toBeDefined();
  });

  test("does not reclaim stale staging temp files that belong to the current run-lock owner", async () => {
    const bytes = await createImageBuffer("png", { r: 146 });
    const maxRunBytes = bytes.byteLength + 32;
    const runId = "current-owner-stage-temp-run";
    const runDirectory = join(assetRoot, "temporary", runId);
    let ownerTokenForTemp: string | null = null;
    const storage = createCatalogAssetStorage({
      heartbeatIntervalMs: 10,
      lockRetryDelayMs: 5,
      lockStaleMs: 40,
      lockTimeoutMs: 400,
      maxRunBytes,
      async onRunLockAcquired(control) {
        ownerTokenForTemp = control.ownerToken;
        await mkdir(runDirectory, { recursive: true });
        await writeFile(
          join(
            runDirectory,
            createStagingTempFileName({
              createdAtMs: Date.now() - 5_000,
              ownerToken: control.ownerToken,
            }),
          ),
          Buffer.alloc(maxRunBytes),
        );
      },
    });

    await expect(
      storage.stageCatalogAsset({
        bytes,
        contentType: "image/png",
        originalFileName: "current-owner-stage.png",
        runId,
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/1\s*GiB|limit/i);

    const runEntries = await readdir(runDirectory);
    expect(runEntries.some((entry) => entry.includes(ownerTokenForTemp as string))).toBe(true);
  });

  test("never follows staging temp symlinks during stale-temp reclaim", async () => {
    const bytes = await createImageBuffer("png", { b: 147 });
    const maxRunBytes = bytes.byteLength + 32;
    const runId = "symlink-stage-temp-run";
    const runDirectory = join(assetRoot, "temporary", runId);
    const outsideDirectory = await mkdtemp(join(tmpdir(), "catalog-assets-stage-symlink-"));
    const outsideTarget = join(outsideDirectory, "outside.bin");
    const staleRegularTemp = join(
      runDirectory,
      createStagingTempFileName({
        createdAtMs: Date.now() - 5_000,
        ownerToken: "33333333-3333-3333-3333-333333333333",
      }),
    );
    const staleSymlinkPath = join(
      runDirectory,
      createStagingTempFileName({
        createdAtMs: Date.now() - 5_000,
        ownerToken: "44444444-4444-4444-4444-444444444444",
      }),
    );

    try {
      await mkdir(runDirectory, { recursive: true });
      await writeFile(staleRegularTemp, Buffer.alloc(maxRunBytes));
      await writeFile(outsideTarget, Buffer.from("outside"));
      await symlink(outsideDirectory, staleSymlinkPath, "junction");
      const storage = createCatalogAssetStorage({
        heartbeatIntervalMs: 10,
        lockRetryDelayMs: 5,
        lockStaleMs: 40,
        lockTimeoutMs: 400,
        maxRunBytes,
      });

      await expect(
        storage.stageCatalogAsset({
          bytes,
          contentType: "image/png",
          originalFileName: "symlink-stage.png",
          runId,
          skuCode: "TZX-001",
        }),
      ).rejects.toThrow(/outside/i);

      await expect(readFile(outsideTarget, "utf8")).resolves.toBe("outside");
      await expect(readFile(staleRegularTemp)).rejects.toThrow();
      expect((await lstat(staleSymlinkPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outsideDirectory, { force: true, recursive: true });
    }
  });

  test("keeps a live run lock across stale-ttl heartbeats", async () => {
    let releaseFirstLock: (() => void) | null = null;
    let firstLockHeartbeatRenewed: (() => void) | null = null;
    let firstLockOwnerToken: string | null = null;
    let firstLockHeld = false;
    let secondFinished = false;
    const firstHeartbeatObserved = new Promise<void>((resolve) => {
      firstLockHeartbeatRenewed = resolve;
    });
    const sharedOptions = {
      heartbeatIntervalMs: 10,
      lockRetryDelayMs: 5,
      lockStaleMs: 40,
      lockTimeoutMs: 400,
    } as const;
    const storageHoldingLock = createCatalogAssetStorage({
      ...sharedOptions,
      onLeaseWrite({ kind, ownerToken }) {
        if (kind === "run" && ownerToken === firstLockOwnerToken) {
          firstLockHeartbeatRenewed?.();
          firstLockHeartbeatRenewed = null;
        }
      },
      onRunLockAcquired(control) {
        firstLockOwnerToken = control.ownerToken;
      },
      onStageWriteReady() {
        firstLockHeld = true;
        return new Promise<void>((resolve) => {
          releaseFirstLock = resolve;
        });
      },
    });
    const storageWaitingForLock = createCatalogAssetStorage(sharedOptions);

    const firstPromise = storageHoldingLock.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 15 }),
      contentType: "image/png",
      originalFileName: "heartbeat-first.png",
      runId: "heartbeat-run",
      skuCode: "TZX-001",
    });

    while (!firstLockHeld) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondPromise = storageWaitingForLock
      .stageCatalogAsset({
        bytes: await createImageBuffer("png", { g: 25 }),
        contentType: "image/png",
        originalFileName: "heartbeat-second.png",
        runId: "heartbeat-run",
        skuCode: "TZX-002",
      })
      .then(() => {
        secondFinished = true;
      });

    await expect(
      Promise.race([
        firstHeartbeatObserved.then(() => "heartbeat"),
        secondPromise.then(() => "finished"),
      ]),
    ).resolves.toBe("heartbeat");
    expect(secondFinished).toBe(false);

    const finishFirstLock = releaseFirstLock as (() => void) | null;
    if (finishFirstLock) {
      finishFirstLock();
    }

    await firstPromise;
    await secondPromise;
  });

  test("reclaims a stale run lock after heartbeat stops without letting the old owner delete the new lock", async () => {
    let releaseFirstLock: (() => void) | null = null;
    let releaseSecondLock: (() => void) | null = null;
    let firstControl: { stopHeartbeat(): void } | null = null;
    let secondLockHeartbeatRenewed: (() => void) | null = null;
    let secondLockOwnerToken: string | null = null;
    let firstLockHeld = false;
    let secondLockHeld = false;
    let thirdFinished = false;
    const secondHeartbeatObserved = new Promise<void>((resolve) => {
      secondLockHeartbeatRenewed = resolve;
    });
    const sharedOptions = {
      heartbeatIntervalMs: 10,
      lockRetryDelayMs: 5,
      lockStaleMs: 40,
      lockTimeoutMs: 500,
    } as const;
    const firstStorage = createCatalogAssetStorage({
      ...sharedOptions,
      onRunLockAcquired(control) {
        firstControl = control;
      },
      onStageWriteReady() {
        firstLockHeld = true;
        return new Promise<void>((resolve) => {
          releaseFirstLock = resolve;
        });
      },
    });
    const secondStorage = createCatalogAssetStorage({
      ...sharedOptions,
      onLeaseWrite({ kind, ownerToken }) {
        if (kind === "run" && ownerToken === secondLockOwnerToken) {
          secondLockHeartbeatRenewed?.();
          secondLockHeartbeatRenewed = null;
        }
      },
      onStageWriteReady() {
        secondLockHeld = true;
        return new Promise<void>((resolve) => {
          releaseSecondLock = resolve;
        });
      },
      onRunLockAcquired(control) {
        secondLockOwnerToken = control.ownerToken;
      },
    });
    const thirdStorage = createCatalogAssetStorage(sharedOptions);

    const firstPromise = firstStorage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 55 }),
      contentType: "image/png",
      originalFileName: "stale-first.png",
      runId: "stale-run",
      skuCode: "TZX-001",
    });

    while (!firstLockHeld || !firstControl) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const staleOwnerControl = firstControl as { stopHeartbeat(): void } | null;
    staleOwnerControl?.stopHeartbeat();
    const secondPromise = secondStorage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { g: 65 }),
      contentType: "image/png",
      originalFileName: "stale-second.png",
      runId: "stale-run",
      skuCode: "TZX-002",
    });

    while (!secondLockHeld) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const thirdPromise = thirdStorage
      .stageCatalogAsset({
        bytes: await createImageBuffer("png", { r: 75 }),
        contentType: "image/png",
        originalFileName: "stale-third.png",
        runId: "stale-run",
        skuCode: "TZX-003",
      })
      .then(() => {
        thirdFinished = true;
      });

    const finishFirstLock = releaseFirstLock as (() => void) | null;
    if (finishFirstLock) {
      finishFirstLock();
    }
    await firstPromise;

    await expect(
      Promise.race([
        secondHeartbeatObserved.then(() => "heartbeat"),
        thirdPromise.then(() => "finished"),
      ]),
    ).resolves.toBe("heartbeat");
    expect(thirdFinished).toBe(false);

    const finishSecondLock = releaseSecondLock as (() => void) | null;
    if (finishSecondLock) {
      finishSecondLock();
    }

    await secondPromise;
    await thirdPromise;
  });

  test("keeps a live publish claim across stale-ttl heartbeats", async () => {
    let releaseFirstClaim: (() => void) | null = null;
    let firstClaimHeartbeatRenewed: (() => void) | null = null;
    let firstClaimOwnerToken: string | null = null;
    let firstClaimHeld = false;
    let secondFinished = false;
    const firstHeartbeatObserved = new Promise<void>((resolve) => {
      firstClaimHeartbeatRenewed = resolve;
    });
    const sharedOptions = {
      claimHeartbeatIntervalMs: 10,
      claimStaleMs: 40,
      lockRetryDelayMs: 5,
      lockTimeoutMs: 400,
      onStorageLink() {
        throw unsupportedLinkError();
      },
    } as const;
    const bytes = await createImageBuffer("png", { b: 31 });
    const firstStorage = createCatalogAssetStorage({
      ...sharedOptions,
      onClaimLeaseAcquired(control) {
        firstClaimOwnerToken = control.ownerToken;
      },
      onLeaseWrite({ kind, ownerToken }) {
        if (kind === "claim" && ownerToken === firstClaimOwnerToken) {
          firstClaimHeartbeatRenewed?.();
          firstClaimHeartbeatRenewed = null;
        }
      },
      onClaimAcquired() {
        firstClaimHeld = true;
        return new Promise<void>((resolve) => {
          releaseFirstClaim = resolve;
        });
      },
    });
    const secondStorage = createCatalogAssetStorage(sharedOptions);
    const firstManifest = await firstStorage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-live-first.png",
      runId: "claim-live-a",
      skuCode: "TZX-001",
    });
    const secondManifest = await secondStorage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-live-second.png",
      runId: "claim-live-b",
      skuCode: "TZX-002",
    });

    const firstCommit = firstStorage.commitCatalogAsset(firstManifest);
    while (!firstClaimHeld) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondCommit = secondStorage.commitCatalogAsset(secondManifest).then(() => {
      secondFinished = true;
    });

    await expect(
      Promise.race([
        firstHeartbeatObserved.then(() => "heartbeat"),
        secondCommit.then(() => "finished"),
      ]),
    ).resolves.toBe("heartbeat");
    expect(secondFinished).toBe(false);

    const finishFirstClaim = releaseFirstClaim as (() => void) | null;
    finishFirstClaim?.();

    await firstCommit;
    await secondCommit;
  });

  test("reclaims a stale publish claim after heartbeat stops without letting the old owner delete the new claim", async () => {
    let releaseFirstClaim: (() => void) | null = null;
    let releaseSecondClaim: (() => void) | null = null;
    let firstClaimControl: { stopHeartbeat(): void } | null = null;
    let secondClaimHeartbeatRenewed: (() => void) | null = null;
    let secondClaimOwnerToken: string | null = null;
    let firstClaimHeld = false;
    let secondClaimHeld = false;
    let thirdFinished = false;
    const secondHeartbeatObserved = new Promise<void>((resolve) => {
      secondClaimHeartbeatRenewed = resolve;
    });
    const sharedOptions = {
      claimHeartbeatIntervalMs: 10,
      claimStaleMs: 40,
      lockRetryDelayMs: 5,
      lockTimeoutMs: 500,
      onStorageLink() {
        throw unsupportedLinkError();
      },
    } as const;
    const bytes = await createImageBuffer("png", { g: 41 });
    const firstStorage = createCatalogAssetStorage({
      ...sharedOptions,
      onClaimLeaseAcquired(control) {
        firstClaimControl = control;
      },
      onClaimAcquired() {
        firstClaimHeld = true;
        return new Promise<void>((resolve) => {
          releaseFirstClaim = resolve;
        });
      },
    });
    const secondStorage = createCatalogAssetStorage({
      ...sharedOptions,
      onClaimAcquired({ ownerToken }) {
        secondClaimOwnerToken = ownerToken;
        secondClaimHeld = true;
        return new Promise<void>((resolve) => {
          releaseSecondClaim = resolve;
        });
      },
      onLeaseWrite({ kind, ownerToken }) {
        if (kind === "claim" && ownerToken === secondClaimOwnerToken) {
          secondClaimHeartbeatRenewed?.();
          secondClaimHeartbeatRenewed = null;
        }
      },
    });
    const thirdStorage = createCatalogAssetStorage(sharedOptions);

    const firstManifest = await firstStorage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-stale-first.png",
      runId: "claim-stale-a",
      skuCode: "TZX-001",
    });
    const secondManifest = await secondStorage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-stale-second.png",
      runId: "claim-stale-b",
      skuCode: "TZX-002",
    });
    const thirdManifest = await thirdStorage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-stale-third.png",
      runId: "claim-stale-c",
      skuCode: "TZX-003",
    });

    const firstCommit = firstStorage.commitCatalogAsset(firstManifest);
    await waitForCondition(() => firstClaimHeld && firstClaimControl !== null);

    (firstClaimControl as { stopHeartbeat(): void } | null)?.stopHeartbeat();
    const secondCommit = secondStorage.commitCatalogAsset(secondManifest);
    await waitForCondition(() => secondClaimHeld);

    const thirdCommit = thirdStorage.commitCatalogAsset(thirdManifest).then(() => {
      thirdFinished = true;
    });

    const finishFirstClaim = releaseFirstClaim as (() => void) | null;
    finishFirstClaim?.();
    await firstCommit;

    await expect(
      Promise.race([
        secondHeartbeatObserved.then(() => "heartbeat"),
        thirdCommit.then(() => "finished"),
      ]),
    ).resolves.toBe("heartbeat");
    expect(thirdFinished).toBe(false);

    const finishSecondClaim = releaseSecondClaim as (() => void) | null;
    finishSecondClaim?.();
    await secondCommit;
    await thirdCommit;
  });

  test("commits the same digest concurrently without leaving partial publishes behind", async () => {
    const bytes = await createImageBuffer("png");
    const first = await stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "first.png",
      runId: "commit-a",
      skuCode: "TZX-001",
    });
    const second = await stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "second.png",
      runId: "commit-b",
      skuCode: "TZX-002",
    });

    const [firstKey, secondKey] = await Promise.all([
      commitCatalogAsset(first),
      commitCatalogAsset(second),
    ]);

    expect(firstKey).toBe(secondKey);
    const finalDirectory = join(assetRoot, dirname(firstKey));
    expect((await readdir(finalDirectory)).filter((entry) => entry.startsWith("."))).toEqual([]);
    const opened = await openCatalogAsset(firstKey);
    expect(Buffer.compare(Buffer.from(opened.bytes), bytes)).toBe(0);
  });

  test("keeps final assets invisible until atomic publish completes", async () => {
    let releasePublish: (() => void) | null = null;
    let publishPaused: Promise<void> | null = null;
    const storage = createCatalogAssetStorage({
      onFinalPublishReady() {
        publishPaused = new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
        return publishPaused;
      },
    });
    const bytes = await createImageBuffer("png");
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "publish.png",
      runId: "publish-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;

    const commitPromise = storage.commitCatalogAsset(manifest);
    while (!publishPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(storage.openCatalogAsset(expectedStorageKey)).rejects.toThrow();
    const finishPublish = releasePublish as (() => void) | null;
    if (finishPublish) {
      finishPublish();
    }
    expect(await commitPromise).toBe(expectedStorageKey);
    expect(Buffer.compare(Buffer.from((await storage.openCatalogAsset(expectedStorageKey)).bytes), bytes)).toBe(0);
  });

  test("falls back to claim-and-rename publish when hard links are unsupported", async () => {
    let releasePublish: (() => void) | null = null;
    let publishPaused = false;
    const storage = createCatalogAssetStorage({
      onFinalPublishReady() {
        publishPaused = true;
        return new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
      },
      onStorageLink() {
        throw unsupportedLinkError();
      },
    });
    const bytes = await createImageBuffer("png");
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "fallback.png",
      runId: "fallback-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;

    const commitPromise = storage.commitCatalogAsset(manifest);
    while (!publishPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(storage.openCatalogAsset(expectedStorageKey)).rejects.toThrow();
    const finishPublish = releasePublish as (() => void) | null;
    if (finishPublish) {
      finishPublish();
    }

    expect(await commitPromise).toBe(expectedStorageKey);
    const finalDirectory = join(assetRoot, dirname(expectedStorageKey));
    expect((await readdir(finalDirectory)).filter((entry) => entry.includes(".claim"))).toEqual([]);
    expect((await readdir(finalDirectory)).filter((entry) => entry.startsWith(".catalog-asset-"))).toEqual([]);
  });

  test("does not overwrite an external target that appears after claim acquisition", async () => {
    let externalWritten = false;
    const storage = createCatalogAssetStorage({
      onClaimAcquired({ targetPath }) {
        return (async () => {
          if (!externalWritten) {
            externalWritten = true;
            await writeFile(targetPath, await createImageBuffer("png", { r: 211 }));
          }
        })();
      },
      onStorageLink() {
        throw unsupportedLinkError();
      },
    });
    const bytes = await createImageBuffer("png", { b: 51 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "external-target.png",
      runId: "external-target-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;
    const targetPath = join(assetRoot, expectedStorageKey);

    await expect(storage.commitCatalogAsset(manifest)).rejects.toThrow(/conflict|digest/i);
    expect(Buffer.compare(await readFile(targetPath), await createImageBuffer("png", { r: 211 }))).toBe(0);
  });

  test("does not return partial bytes while fallback copy is in progress", async () => {
    let releaseCopy: (() => void) | null = null;
    let partialVisible = false;
    const storage = createCatalogAssetStorage({
      onStorageLink() {
        throw unsupportedLinkError();
      },
      onTargetWriteProgress({ bytesWritten, totalBytes }) {
        if (!partialVisible && bytesWritten > 0 && bytesWritten < totalBytes) {
          partialVisible = true;
          return new Promise<void>((resolve) => {
            releaseCopy = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const bytes = await createImageBuffer("png", { g: 144 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "partial-copy.png",
      runId: "partial-copy-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;

    const commitPromise = storage.commitCatalogAsset(manifest);
    while (!partialVisible) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(storage.openCatalogAsset(expectedStorageKey)).rejects.toThrow();
    const finishCopy = releaseCopy as (() => void) | null;
    finishCopy?.();
    expect(await commitPromise).toBe(expectedStorageKey);
  });

  test("aborts staged writes after the run lease heartbeat is lost", async () => {
    let releaseStage: (() => void) | null = null;
    let heartbeatWrites = 0;
    const storage = createCatalogAssetStorage({
      heartbeatIntervalMs: 10,
      lockStaleMs: 80,
      onLeaseWrite({ kind }) {
        if (kind !== "run") {
          return;
        }
        heartbeatWrites += 1;
        if (heartbeatWrites >= 2) {
          throw new Error("simulated run lease heartbeat failure");
        }
      },
      onStageWriteReady() {
        return new Promise<void>((resolve) => {
          releaseStage = resolve;
        });
      },
    });
    const bytes = await createImageBuffer("png", { b: 61 });
    const stagePromise = storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "lease-lost-stage.png",
      runId: "lease-lost-stage-run",
      skuCode: "TZX-001",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    const continueStage = releaseStage as (() => void) | null;
    continueStage?.();

    await expect(stagePromise).rejects.toThrow(/lease/i);
  });

  test("does not publish or retain temp bytes after a run lease is lost mid-write and another worker reclaims the run", async () => {
    let releaseFirstWrite: (() => void) | null = null;
    let firstWritePaused = false;
    let runHeartbeatWrites = 0;
    const firstBytes = await createImageBuffer("png", { b: 101 });
    const secondBytes = await createImageBuffer("png", { g: 111 });
    const maxRunBytes = Math.max(firstBytes.byteLength, secondBytes.byteLength) + 16;
    const sharedOptions = {
      heartbeatIntervalMs: 10,
      lockRetryDelayMs: 5,
      lockStaleMs: 80,
      lockTimeoutMs: 700,
      maxRunBytes,
      targetWriteChunkSize: 32,
    } as const;
    const firstStorage = createCatalogAssetStorage({
      ...sharedOptions,
      onLeaseWrite({ kind }) {
        if (kind !== "run") {
          return;
        }
        runHeartbeatWrites += 1;
        if (runHeartbeatWrites >= 2) {
          throw new Error("simulated run lease heartbeat failure");
        }
      },
      onTemporaryWriteProgress({ bytesWritten, totalBytes }) {
        if (!firstWritePaused && bytesWritten > 0 && bytesWritten < totalBytes) {
          firstWritePaused = true;
          return new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
      },
    });
    const secondStorage = createCatalogAssetStorage(sharedOptions);
    const firstStagePromise = firstStorage.stageCatalogAsset({
      bytes: firstBytes,
      contentType: "image/png",
      originalFileName: "lease-lost-first.png",
      runId: "lease-lost-mid-write-run",
      skuCode: "TZX-001",
    });

    while (!firstWritePaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondStagePromise = secondStorage.stageCatalogAsset({
      bytes: secondBytes,
      contentType: "image/png",
      originalFileName: "lease-lost-second.png",
      runId: "lease-lost-mid-write-run",
      skuCode: "TZX-002",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    const continueFirstWrite = releaseFirstWrite as (() => void) | null;
    continueFirstWrite?.();

    await expect(firstStagePromise).rejects.toThrow(/lease/i);

    const secondManifest = await secondStagePromise;
    const runDirectory = stagedRunDirectory(secondManifest);
    const runEntries = await readdir(runDirectory);
    expect(runEntries.filter((entry) => entry.startsWith(".catalog-asset-"))).toEqual([]);
    expect(runEntries.filter((entry) => entry.endsWith(".png"))).toEqual([
      `${secondManifest.contentSha256}.png`,
    ]);
    expect(await sumDirectoryBytes(runDirectory)).toBeLessThanOrEqual(maxRunBytes);
  });

  test("aborts fallback publish after the claim lease heartbeat is lost", async () => {
    let releaseClaim: (() => void) | null = null;
    let claimHeartbeatWrites = 0;
    const storage = createCatalogAssetStorage({
      claimHeartbeatIntervalMs: 10,
      claimStaleMs: 80,
      onClaimAcquired() {
        return new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
      },
      onLeaseWrite({ kind }) {
        if (kind !== "claim") {
          return;
        }
        claimHeartbeatWrites += 1;
        if (claimHeartbeatWrites >= 2) {
          throw new Error("simulated claim lease heartbeat failure");
        }
      },
      onStorageLink() {
        throw unsupportedLinkError();
      },
    });
    const bytes = await createImageBuffer("png", { g: 171 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "lease-lost-claim.png",
      runId: "lease-lost-claim-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;
    const commitPromise = storage.commitCatalogAsset(manifest);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const continueClaim = releaseClaim as (() => void) | null;
    continueClaim?.();

    await expect(commitPromise).rejects.toThrow(/lease/i);
    await expect(storage.openCatalogAsset(expectedStorageKey)).rejects.toThrow();
  });

  test("does not delete a replacement target after the claim lease is lost", async () => {
    let releaseCopy: (() => void) | null = null;
    let partialVisible = false;
    let claimHeartbeatWrites = 0;
    let replacementWritten = false;
    const replacementBytes = await createImageBuffer("png", { r: 230 });
    const storage = createCatalogAssetStorage({
      claimHeartbeatIntervalMs: 10,
      claimStaleMs: 80,
      onLeaseWrite({ kind }) {
        if (kind !== "claim") {
          return;
        }
        claimHeartbeatWrites += 1;
        if (claimHeartbeatWrites >= 2) {
          throw new Error("simulated claim lease heartbeat failure");
        }
      },
      onStorageLink() {
        throw unsupportedLinkError();
      },
      onTargetCleanup: async ({ targetPath }) => {
        replacementWritten = true;
        await rm(targetPath, { force: true });
        await writeFile(targetPath, replacementBytes);
      },
      onTargetWriteProgress({ bytesWritten, totalBytes }) {
        if (!partialVisible && bytesWritten > 0 && bytesWritten < totalBytes) {
          partialVisible = true;
          return new Promise<void>((resolve) => {
            releaseCopy = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const bytes = await createImageBuffer("png", { b: 81 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-replacement.png",
      runId: "claim-replacement-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;
    const targetPath = join(assetRoot, expectedStorageKey);
    const commitPromise = storage.commitCatalogAsset(manifest);

    while (!partialVisible) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await new Promise((resolve) => setTimeout(resolve, 60));
    const continueCopy = releaseCopy as (() => void) | null;
    continueCopy?.();

    await expect(commitPromise).rejects.toThrow(/lease/i);
    expect(replacementWritten).toBe(true);
    expect(Buffer.compare(await readFile(targetPath), replacementBytes)).toBe(0);
  });

  test("cleans up its own fallback target when publish fails while the claim lease is still held", async () => {
    const storage = createCatalogAssetStorage({
      onDirectorySync(path, reason) {
        if (reason === "publish" && path.includes(`${join(assetRoot, "sha256")}`)) {
          throw new Error("simulated publish sync failure");
        }
      },
      onStorageLink() {
        throw unsupportedLinkError();
      },
    });
    const bytes = await createImageBuffer("png", { g: 181 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "claim-cleanup.png",
      runId: "claim-cleanup-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;

    await expect(storage.commitCatalogAsset(manifest)).rejects.toThrow(/publish sync failure/i);
    await expect(readFile(join(assetRoot, expectedStorageKey))).rejects.toThrow();
  });

  test("commits the same digest concurrently when hard links are unsupported", async () => {
    const storage = createCatalogAssetStorage({
      onStorageLink() {
        throw unsupportedLinkError();
      },
    });
    const bytes = await createImageBuffer("png");
    const first = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "fallback-first.png",
      runId: "fallback-commit-a",
      skuCode: "TZX-001",
    });
    const second = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "fallback-second.png",
      runId: "fallback-commit-b",
      skuCode: "TZX-002",
    });

    const [firstKey, secondKey] = await Promise.all([
      storage.commitCatalogAsset(first),
      storage.commitCatalogAsset(second),
    ]);

    expect(firstKey).toBe(secondKey);
    const finalDirectory = join(assetRoot, dirname(firstKey));
    expect((await readdir(finalDirectory)).filter((entry) => entry.includes(".claim"))).toEqual([]);
  });

  test("syncs the final directory after publish and cleanup", async () => {
    const syncEvents: Array<{ path: string; reason: string }> = [];
    const storage = createCatalogAssetStorage({
      onDirectorySync(path, reason) {
        syncEvents.push({ path, reason });
      },
    });
    const bytes = await createImageBuffer("png");
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "sync-directory.png",
      runId: "sync-directory-run",
      skuCode: "TZX-001",
    });

    const storageKey = await storage.commitCatalogAsset(manifest);
    const finalDirectory = join(assetRoot, dirname(storageKey));
    expect(syncEvents).toEqual(
      expect.arrayContaining([
        { path: finalDirectory, reason: "publish" },
        { path: finalDirectory, reason: "cleanup" },
      ]),
    );
  });

  test("rejects symlink escapes for staging and final asset reads", async () => {
    const outside = await mkdtemp(join(tmpdir(), "catalog-assets-outside-"));

    try {
      await rm(join(assetRoot, "temporary"), { force: true, recursive: true });
      await symlink(outside, join(assetRoot, "temporary"), "junction");

      await expect(
        stageCatalogAsset({
          bytes: await createImageBuffer("png"),
          contentType: "image/png",
          originalFileName: "symlink.png",
          runId: "run-a",
          skuCode: "TZX-001",
        }),
      ).rejects.toThrow(/outside/i);

      await rm(join(assetRoot, "temporary"), { force: true, recursive: true });
      const manifest = await stageCatalogAsset({
        bytes: await createImageBuffer("png"),
        contentType: "image/png",
        originalFileName: "committed.png",
        runId: "run-a",
        skuCode: "TZX-001",
      });
      const storageKey = await commitCatalogAsset(manifest);

      await rm(join(assetRoot, "sha256"), { force: true, recursive: true });
      await symlink(outside, join(assetRoot, "sha256"), "junction");

      await expect(openCatalogAsset(storageKey)).rejects.toThrow(/outside/i);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("rejects symlink escapes for final publish parents", async () => {
    const outside = await mkdtemp(join(tmpdir(), "catalog-assets-outside-"));

    try {
      const manifest = await stageCatalogAsset({
        bytes: await createImageBuffer("png"),
        contentType: "image/png",
        originalFileName: "commit-parent.png",
        runId: "commit-parent",
        skuCode: "TZX-001",
      });
      await rm(join(assetRoot, "sha256"), { force: true, recursive: true });
      await symlink(outside, join(assetRoot, "sha256"), "junction");

      await expect(commitCatalogAsset(manifest)).rejects.toThrow(/outside/i);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
