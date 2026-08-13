import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  CatalogAssetCoordinator,
  CatalogAssetLockGuard,
} from "@/modules/feishu/asset-coordination";
import type { TemporaryAssetManifest } from "@/modules/feishu/cargo-types";
import { createCatalogAssetStorage } from "@/modules/feishu/asset-storage";

const ONE_MEBIBYTE = 1024 * 1024;
const MAX_FILE_BYTES = 8 * ONE_MEBIBYTE;
let assetRoot: string;

function createStagingTempFileName(input: { createdAtMs: number }) {
  return `.catalog-asset-stage-${input.createdAtMs}-${crypto.randomUUID()}.tmp`;
}

function createFinalTempFileName(input: { contentSha256: string; createdAtMs: number }) {
  return `.catalog-asset-digest-${input.contentSha256}-${input.createdAtMs}-${crypto.randomUUID()}.tmp`;
}

function createFakeCoordinator() {
  const activeDigests = new Set<string>();
  const activeRuns = new Set<string>();
  const digestControllers = new Map<string, AbortController>();
  const events: Array<{ key: string; scope: "digest" | "run" }> = [];
  const runControllers = new Map<string, AbortController>();

  function createGuard(controller: AbortController): CatalogAssetLockGuard {
    return {
      signal: controller.signal,
      async assertHeld() {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("catalog asset lock was lost");
        }
      },
    };
  }

  const coordinator: CatalogAssetCoordinator = {
    async withDigestLock<T>(digest: string, action: (guard: CatalogAssetLockGuard) => Promise<T>) {
      events.push({ key: digest, scope: "digest" });
      activeDigests.add(digest);
      const controller = new AbortController();
      digestControllers.set(digest, controller);
      try {
        return await action(createGuard(controller));
      } finally {
        activeDigests.delete(digest);
        digestControllers.delete(digest);
      }
    },
    async withRunLock<T>(runId: string, action: (guard: CatalogAssetLockGuard) => Promise<T>) {
      events.push({ key: runId, scope: "run" });
      activeRuns.add(runId);
      const controller = new AbortController();
      runControllers.set(runId, controller);
      try {
        return await action(createGuard(controller));
      } finally {
        activeRuns.delete(runId);
        runControllers.delete(runId);
      }
    },
  };

  return {
    activeDigests,
    activeRuns,
    abortDigest(digest: string, reason = new Error("catalog asset digest lock was lost")) {
      digestControllers.get(digest)?.abort(reason);
    },
    abortRun(runId: string, reason = new Error("catalog asset run lock was lost")) {
      runControllers.get(runId)?.abort(reason);
    },
    coordinator,
    events,
  };
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

beforeEach(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "catalog-assets-"));
});

afterEach(async () => {
  await rm(assetRoot, { force: true, recursive: true });
});

describe("catalog asset storage", () => {
  test.each([
    { extension: "jpg", format: "jpeg", mimeType: "image/jpeg" as const },
    { extension: "png", format: "png", mimeType: "image/png" as const },
    { extension: "webp", format: "webp", mimeType: "image/webp" as const },
  ] as const)(
    "accepts real $mimeType bytes, deduplicates content, and opens committed assets under fake run/digest coordinators",
    async ({ extension, format, mimeType }) => {
      const fakeCoordinator = createFakeCoordinator();
      let expectedDigest: string | null = null;
      const storage = createCatalogAssetStorage({
        assetDir: assetRoot,
        coordinator: fakeCoordinator.coordinator,
        onFinalPublishReady() {
          expect(expectedDigest).not.toBeNull();
          expect(fakeCoordinator.activeRuns.size).toBe(0);
          expect(fakeCoordinator.activeDigests.has(expectedDigest as string)).toBe(true);
        },
        onStageWriteReady() {
          expect(fakeCoordinator.activeRuns.size).toBe(1);
          expect(fakeCoordinator.activeDigests.size).toBe(0);
        },
      });
      const bytes = await createImageBuffer(format);

      const staged = await storage.stageCatalogAsset({
        bytes,
        contentType: mimeType,
        originalFileName: `fixture.${extension}`,
        runId: "run-a",
        skuCode: "TZX-001",
      });
      expectedDigest = staged.contentSha256;
      const duplicateStage = await storage.stageCatalogAsset({
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

      const storageKey = await storage.commitCatalogAsset(staged);
      expect(storageKey).toMatch(
        new RegExp(`^sha256/[0-9a-f]{2}/[0-9a-f]{64}\\.${extension}$`),
      );

      const secondRun = await storage.stageCatalogAsset({
        bytes,
        contentType: mimeType,
        originalFileName: `second-run.${extension}`,
        runId: "run-b",
        skuCode: "TZX-001",
      });
      expect(await storage.commitCatalogAsset(secondRun)).toBe(storageKey);

      const opened = await storage.openCatalogAsset(storageKey);
      expect(opened.contentType).toBe(mimeType);
      expect(Buffer.compare(Buffer.from(opened.bytes), bytes)).toBe(0);
      expect(fakeCoordinator.events).toEqual([
        { key: "run-a", scope: "run" },
        { key: "run-a", scope: "run" },
        { key: staged.contentSha256, scope: "digest" },
        { key: "run-b", scope: "run" },
        { key: staged.contentSha256, scope: "digest" },
      ]);

      await expect(readFile(join(assetRoot, staged.temporaryKey))).rejects.toThrow();
      await expect(readFile(join(assetRoot, secondRun.temporaryKey))).rejects.toThrow();
    },
  );

  test("rejects mismatched mime types and unsupported SVG payloads", async () => {
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: createFakeCoordinator().coordinator,
    });
    const png = await createImageBuffer("png");

    await expect(
      storage.stageCatalogAsset({
        bytes: png,
        contentType: "image/jpeg",
        originalFileName: "bad-mime.png",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/content type/i);

    await expect(
      storage.stageCatalogAsset({
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        contentType: "image/svg+xml",
        originalFileName: "vector.svg",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/unsupported/i);
  });

  test("rejects oversized files and images above the pixel limit", async () => {
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: createFakeCoordinator().coordinator,
    });

    await expect(
      storage.stageCatalogAsset({
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
      storage.stageCatalogAsset({
        bytes: bomb,
        contentType: "image/png",
        originalFileName: "bomb.png",
        runId: "run-a",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/25,?000,?000/i);
  });

  test("rejects traversal in run ids, temporary keys, and storage keys", async () => {
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: createFakeCoordinator().coordinator,
    });
    const png = await createImageBuffer("png");

    await expect(
      storage.stageCatalogAsset({
        bytes: png,
        contentType: "image/png",
        originalFileName: "escape.png",
        runId: "../escape",
        skuCode: "TZX-001",
      }),
    ).rejects.toThrow(/run id/i);

    await expect(
      storage.commitCatalogAsset({
        byteSize: png.byteLength,
        contentSha256: "a".repeat(64),
        mimeType: "image/png",
        originalFileName: "escape.png",
        skuCode: "TZX-001",
        temporaryKey: "../escape.png",
      }),
    ).rejects.toThrow(/temporary/i);

    await expect(storage.openCatalogAsset("../escape.png")).rejects.toThrow(/storage key/i);
  });

  test("enforces the cumulative run limit and can discard staged assets with the fake coordinator", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const maxRunBytes = 12_000;
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: fakeCoordinator.coordinator,
      maxRunBytes,
    });
    const first = await storage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 20 }),
      contentType: "image/png",
      originalFileName: "first.png",
      runId: "run-a",
      skuCode: "TZX-001",
    });
    const fillerPath = join(stagedRunDirectory(first), "filler.bin");
    const secondBytes = await createImageBuffer("png", { g: 12 });
    const fillerSize = maxRunBytes - first.byteSize - secondBytes.byteLength + 1;
    await writeFile(fillerPath, Buffer.alloc(fillerSize));

    await expect(
      storage.stageCatalogAsset({
        bytes: secondBytes,
        contentType: "image/png",
        originalFileName: "second.png",
        runId: "run-a",
        skuCode: "TZX-002",
      }),
    ).rejects.toThrow(/1\s*GiB/i);

    await storage.discardStagedAssets("run-a");
    await expect(readFile(join(assetRoot, first.temporaryKey))).rejects.toThrow();
    expect(fakeCoordinator.events.at(-1)).toEqual({ key: "run-a", scope: "run" });
  });

  test("reclaims stale staging temp files but fails safe when a symlink remains in the run directory", async () => {
    const fakeCoordinator = createFakeCoordinator();
    const bytes = await createImageBuffer("png", { b: 140 });
    const maxRunBytes = bytes.byteLength + 32;
    const runId = "stale-stage-temp-run";
    const runDirectory = join(assetRoot, "temporary", runId);
    const staleTempPath = join(
      runDirectory,
      createStagingTempFileName({
        createdAtMs: Date.now() - 5_000,
      }),
    );
    const freshTempPath = join(
      runDirectory,
      createStagingTempFileName({
        createdAtMs: Date.now(),
      }),
    );
    const outsideDirectory = await mkdtemp(join(tmpdir(), "catalog-assets-stage-symlink-"));
    const outsideTarget = join(outsideDirectory, "outside.bin");
    const symlinkTempPath = join(
      runDirectory,
      createStagingTempFileName({
        createdAtMs: Date.now() - 5_000,
      }),
    );

    try {
      await mkdir(runDirectory, { recursive: true });
      await writeFile(staleTempPath, Buffer.alloc(maxRunBytes));
      await writeFile(freshTempPath, Buffer.from("fresh"));
      await writeFile(outsideTarget, Buffer.from("outside"));
      await symlink(outsideDirectory, symlinkTempPath, "junction");
      const storage = createCatalogAssetStorage({
        assetDir: assetRoot,
        coordinator: fakeCoordinator.coordinator,
        maxRunBytes,
        temporaryFileStaleMs: 40,
      });

      await expect(
        storage.stageCatalogAsset({
          bytes,
          contentType: "image/png",
          originalFileName: "stale-stage.png",
          runId,
          skuCode: "TZX-001",
        }),
      ).rejects.toThrow(/outside/i);

      await expect(readFile(staleTempPath)).rejects.toThrow();
      await expect(readFile(freshTempPath)).resolves.toBeDefined();
      await expect(readFile(outsideTarget, "utf8")).resolves.toBe("outside");
      expect((await lstat(symlinkTempPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outsideDirectory, { force: true, recursive: true });
    }
  });

  test("reclaims stale digest temp files and keeps final assets invisible until publish completes", async () => {
    const fakeCoordinator = createFakeCoordinator();
    let releasePublish: (() => void) | null = null;
    let publishPaused = false;
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: fakeCoordinator.coordinator,
      onFinalPublishReady() {
        publishPaused = true;
        return new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
      },
      temporaryFileStaleMs: 40,
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
    const finalDirectory = join(assetRoot, dirname(expectedStorageKey));
    await mkdir(finalDirectory, { recursive: true });
    await writeFile(
      join(
        finalDirectory,
        createFinalTempFileName({
          contentSha256: manifest.contentSha256,
          createdAtMs: Date.now() - 5_000,
        }),
      ),
      Buffer.from("stale-temp"),
    );

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
    expect((await readdir(finalDirectory)).filter((entry) => entry.startsWith(".catalog-asset-digest-"))).toEqual([]);
  });

  test("does not delete another digest's live temp file when the digests share the same prefix", async () => {
    const fakeCoordinator = createFakeCoordinator();
    let releaseFirstPublish: (() => void) | null = null;
    let firstPublishPaused = false;
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: fakeCoordinator.coordinator,
      onFinalPublishReady() {
        if (!firstPublishPaused) {
          firstPublishPaused = true;
          return new Promise<void>((resolve) => {
            releaseFirstPublish = resolve;
          });
        }
      },
      temporaryFileStaleMs: -1,
    });

    let firstManifest: TemporaryAssetManifest | null = null;
    let secondManifest: TemporaryAssetManifest | null = null;
    for (let index = 0; index < 256 && (!firstManifest || !secondManifest); index += 1) {
      const manifest = await storage.stageCatalogAsset({
        bytes: await createImageBuffer("png", { b: 20 + index, g: 30 + index, r: 40 + index }),
        contentType: "image/png",
        originalFileName: `prefix-${index}.png`,
        runId: `prefix-run-${index}`,
        skuCode: `TZX-${index}`,
      });
      if (!firstManifest) {
        firstManifest = manifest;
        continue;
      }
      if (
        manifest.contentSha256 !== firstManifest.contentSha256 &&
        manifest.contentSha256.slice(0, 2) === firstManifest.contentSha256.slice(0, 2)
      ) {
        secondManifest = manifest;
      }
    }

    expect(firstManifest).not.toBeNull();
    expect(secondManifest).not.toBeNull();

    const firstCommit = storage.commitCatalogAsset(firstManifest as TemporaryAssetManifest);
    while (!firstPublishPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const prefixDirectory = join(
      assetRoot,
      "sha256",
      (firstManifest as TemporaryAssetManifest).contentSha256.slice(0, 2),
    );
    const entriesBeforeSecondCommit = await readdir(prefixDirectory);
    const firstDigestTempEntry = entriesBeforeSecondCommit.find((entry) =>
      entry.includes((firstManifest as TemporaryAssetManifest).contentSha256),
    );
    expect(firstDigestTempEntry).toBeDefined();

    const secondStorageKey = await storage.commitCatalogAsset(secondManifest as TemporaryAssetManifest);
    const entriesAfterSecondCommit = await readdir(prefixDirectory);
    expect(entriesAfterSecondCommit).toContain(firstDigestTempEntry as string);
    expect(entriesAfterSecondCommit).toContain(
      `${(secondManifest as TemporaryAssetManifest).contentSha256}.png`,
    );

    const finishFirstPublish = releaseFirstPublish as (() => void) | null;
    if (finishFirstPublish) {
      finishFirstPublish();
    }

    await expect(firstCommit).resolves.toBe(
      `sha256/${(firstManifest as TemporaryAssetManifest).contentSha256.slice(0, 2)}/${(firstManifest as TemporaryAssetManifest).contentSha256}.png`,
    );
    expect(secondStorageKey).toBe(
      `sha256/${(secondManifest as TemporaryAssetManifest).contentSha256.slice(0, 2)}/${(secondManifest as TemporaryAssetManifest).contentSha256}.png`,
    );
  });

  test("falls back to copy publish when hard links are unsupported", async () => {
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: createFakeCoordinator().coordinator,
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

    expect(await storage.commitCatalogAsset(manifest)).toBe(expectedStorageKey);
    const finalDirectory = join(assetRoot, dirname(expectedStorageKey));
    expect((await readdir(finalDirectory)).filter((entry) => entry.startsWith("."))).toEqual([]);
  });

  test("cleans up fallback targets it created when publish fails", async () => {
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: createFakeCoordinator().coordinator,
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

  test("aborts a staged write when the fake run guard is lost mid-write", async () => {
    const fakeCoordinator = createFakeCoordinator();
    let runId = "";
    let releaseWrite: (() => void) | null = null;
    let writePaused = false;
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: fakeCoordinator.coordinator,
      onTemporaryWriteProgress({ bytesWritten, totalBytes }) {
        if (!writePaused && bytesWritten > 0 && bytesWritten < totalBytes) {
          writePaused = true;
          return new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const bytes = await createImageBuffer("png", { b: 11, g: 12, r: 13, width: 64, height: 64 });
    runId = "fake-run-guard-loss";

    const stagePromise = storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "guard-loss-stage.png",
      runId,
      skuCode: "TZX-001",
    });

    while (!writePaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    fakeCoordinator.abortRun(runId);
    const continueWrite = releaseWrite as (() => void) | null;
    if (continueWrite) {
      continueWrite();
    }

    await expect(stagePromise).rejects.toThrow(/lock was lost/i);
    expect((await readdir(join(assetRoot, "temporary", runId))).filter((entry) => entry.startsWith(".catalog-asset-stage-"))).toEqual([]);
  });

  test("aborts a fallback publish when the fake digest guard is lost mid-copy", async () => {
    const fakeCoordinator = createFakeCoordinator();
    let releaseCopy: (() => void) | null = null;
    let copyPaused = false;
    let expectedTargetPath = "";
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: fakeCoordinator.coordinator,
      onStorageLink() {
        throw unsupportedLinkError();
      },
      onTargetWriteProgress({ bytesWritten, targetPath, totalBytes }) {
        if (
          !copyPaused &&
          targetPath === expectedTargetPath &&
          bytesWritten > 0 &&
          bytesWritten < totalBytes
        ) {
          copyPaused = true;
          return new Promise<void>((resolve) => {
            releaseCopy = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const bytes = await createImageBuffer("png", { b: 14, g: 15, r: 16, width: 64, height: 64 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "guard-loss-commit.png",
      runId: "fake-digest-guard-loss-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;
    expectedTargetPath = join(assetRoot, expectedStorageKey);

    const commitPromise = storage.commitCatalogAsset(manifest);
    while (!copyPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const partialStats = await lstat(expectedTargetPath);
    expect(partialStats.isFile()).toBe(true);
    expect(partialStats.size).toBeGreaterThan(0);
    expect(partialStats.size).toBeLessThan(bytes.byteLength);

    fakeCoordinator.abortDigest(manifest.contentSha256);
    const continueCopy = releaseCopy as (() => void) | null;
    if (continueCopy) {
      continueCopy();
    }

    await expect(commitPromise).rejects.toThrow(/lock was lost/i);
    await expect(readFile(join(assetRoot, expectedStorageKey))).rejects.toThrow();
    await expect(storage.commitCatalogAsset(manifest)).resolves.toBe(expectedStorageKey);
  });

  test("preserves a replacement fallback target created during cleanup after digest lock loss", async () => {
    const fakeCoordinator = createFakeCoordinator();
    let releaseCopy: (() => void) | null = null;
    let copyPaused = false;
    let replacementWritten = false;
    let expectedTargetPath = "";
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: fakeCoordinator.coordinator,
      onStorageLink() {
        throw unsupportedLinkError();
      },
      async onTargetCleanup({ targetPath }) {
        if (targetPath !== expectedTargetPath || replacementWritten) {
          return;
        }
        replacementWritten = true;
        await rm(targetPath, { force: true });
        await writeFile(targetPath, bytes);
      },
      onTargetWriteProgress({ bytesWritten, targetPath, totalBytes }) {
        if (
          !copyPaused &&
          targetPath === expectedTargetPath &&
          bytesWritten > 0 &&
          bytesWritten < totalBytes
        ) {
          copyPaused = true;
          return new Promise<void>((resolve) => {
            releaseCopy = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const bytes = await createImageBuffer("png", { b: 17, g: 18, r: 19, width: 64, height: 64 });
    const manifest = await storage.stageCatalogAsset({
      bytes,
      contentType: "image/png",
      originalFileName: "guard-loss-replacement.png",
      runId: "fake-digest-replacement-run",
      skuCode: "TZX-001",
    });
    const expectedStorageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.png`;
    expectedTargetPath = join(assetRoot, expectedStorageKey);

    const commitPromise = storage.commitCatalogAsset(manifest);
    while (!copyPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    fakeCoordinator.abortDigest(manifest.contentSha256);
    const continueCopy = releaseCopy as (() => void) | null;
    if (continueCopy) {
      continueCopy();
    }

    await expect(commitPromise).rejects.toThrow(/lock was lost/i);
    expect(replacementWritten).toBe(true);
    expect(Buffer.compare(await readFile(expectedTargetPath), bytes)).toBe(0);
    await expect(storage.commitCatalogAsset(manifest)).resolves.toBe(expectedStorageKey);
  });

  test("rejects symlink escapes for staging, commit parent, and final asset reads", async () => {
    const storage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: createFakeCoordinator().coordinator,
    });
    const outside = await mkdtemp(join(tmpdir(), "catalog-assets-outside-"));

    try {
      await rm(join(assetRoot, "temporary"), { force: true, recursive: true });
      await symlink(outside, join(assetRoot, "temporary"), "junction");

      await expect(
        storage.stageCatalogAsset({
          bytes: await createImageBuffer("png"),
          contentType: "image/png",
          originalFileName: "symlink.png",
          runId: "run-a",
          skuCode: "TZX-001",
        }),
      ).rejects.toThrow(/outside/i);

      await rm(join(assetRoot, "temporary"), { force: true, recursive: true });
      const manifest = await storage.stageCatalogAsset({
        bytes: await createImageBuffer("png"),
        contentType: "image/png",
        originalFileName: "committed.png",
        runId: "run-a",
        skuCode: "TZX-001",
      });
      await rm(join(assetRoot, "sha256"), { force: true, recursive: true });
      await symlink(outside, join(assetRoot, "sha256"), "junction");

      await expect(storage.commitCatalogAsset(manifest)).rejects.toThrow(/outside/i);

      await rm(join(assetRoot, "sha256"), { force: true, recursive: true });
      const committedManifest = await storage.stageCatalogAsset({
        bytes: await createImageBuffer("png", { b: 5 }),
        contentType: "image/png",
        originalFileName: "open.png",
        runId: "run-b",
        skuCode: "TZX-002",
      });
      const storageKey = await storage.commitCatalogAsset(committedManifest);
      await rm(join(assetRoot, "sha256"), { force: true, recursive: true });
      await symlink(outside, join(assetRoot, "sha256"), "junction");

      await expect(storage.openCatalogAsset(storageKey)).rejects.toThrow(/outside/i);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
