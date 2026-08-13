import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import sharp from "sharp";
import { afterEach, describe, expect, test } from "vitest";

import {
  createPostgresCatalogAssetCoordinator,
} from "@/modules/feishu/asset-coordination";
import { createCatalogAssetStorage } from "@/modules/feishu/asset-storage";

type IndependentCoordinator = ReturnType<typeof createPostgresCatalogAssetCoordinator>;

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

function requireDatabaseUrl() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for asset coordination integration tests");
  }
  return DATABASE_URL;
}

function unsupportedLinkError() {
  const error = new Error("hard links are not supported on this volume") as NodeJS.ErrnoException;
  error.code = "ENOTSUP";
  return error;
}

async function createImageBuffer(
  format: "png" | "webp",
  input?: { b?: number; g?: number; height?: number; r?: number; width?: number },
) {
  const width = input?.width ?? 24;
  const height = input?.height ?? 18;
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

  if (format === "webp") {
    return image.webp().toBuffer();
  }

  return image.png().toBuffer();
}

function createIndependentCoordinator(input?: { heartbeatIntervalMs?: number; lockTimeoutMs?: number }) {
  const client = postgres(requireDatabaseUrl(), { idle_timeout: 1, max: 1 });
  const isolatedDb = drizzle({ client });

  return {
    client,
    coordinator: createPostgresCatalogAssetCoordinator({
      db: isolatedDb,
      heartbeatIntervalMs: input?.heartbeatIntervalMs ?? 10,
      lockTimeoutMs: input?.lockTimeoutMs,
    }),
  };
}

async function closeIndependentCoordinator(
  instance: { client: postgres.Sql; coordinator: IndependentCoordinator } | null,
) {
  if (!instance) {
    return;
  }
  await instance.client.end({ timeout: 0 });
}

async function sumDirectoryBytes(directoryPath: string): Promise<number> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
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

describe("catalog asset PostgreSQL coordination", () => {
  let assetRoot: string;
  const coordinators = new Set<{ client: postgres.Sql; coordinator: IndependentCoordinator }>();

  afterEach(async () => {
    for (const coordinator of coordinators) {
      await closeIndependentCoordinator(coordinator);
    }
    coordinators.clear();
    await rm(assetRoot, { force: true, recursive: true }).catch(() => undefined);
  });

  test("releases a run advisory lock when the holding connection closes so a waiter can continue", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "catalog-asset-coordination-"));
    const holder = createIndependentCoordinator();
    const waiter = createIndependentCoordinator();
    coordinators.add(holder);
    coordinators.add(waiter);

    let releaseHolder: (() => void) | null = null;
    let holderAcquired = false;
    let waiterAcquired = false;

    const holdingTask = holder.coordinator.withRunLock("coordination-crash-run", async () => {
      holderAcquired = true;
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });

    while (!holderAcquired) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const waiterTask = waiter.coordinator.withRunLock("coordination-crash-run", async () => {
      waiterAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(waiterAcquired).toBe(false);

    await holder.client.end({ timeout: 0 });
    coordinators.delete(holder);
    await expect(holdingTask).rejects.toThrow();
    await waiterTask;
    expect(waiterAcquired).toBe(true);

    const finishHolderAfterCrash = releaseHolder as (() => void) | null;
    if (finishHolderAfterCrash) {
      finishHolderAfterCrash();
    }
  });

  test("maps advisory lock timeouts to a stable sanitized coordination error", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "catalog-asset-coordination-"));
    const holder = createIndependentCoordinator();
    const waiter = createIndependentCoordinator({ lockTimeoutMs: 100 });
    coordinators.add(holder);
    coordinators.add(waiter);

    let releaseHolder: (() => void) | null = null;
    let holderAcquired = false;

    const holdingTask = holder.coordinator.withDigestLock("a".repeat(64), async () => {
      holderAcquired = true;
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });

    while (!holderAcquired) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await expect(waiter.coordinator.withDigestLock("a".repeat(64), async () => undefined)).rejects.toMatchObject({
      code: "CATALOG_ASSET_COORDINATION_TIMEOUT",
      message: "catalog asset coordination timed out",
    });
    await expect(
      waiter.coordinator.withDigestLock("a".repeat(64), async () => undefined),
    ).rejects.not.toThrow(/a{64}|digest|select|postgres:\/\//i);

    const finishHolder = releaseHolder as (() => void) | null;
    if (finishHolder) {
      finishHolder();
    }
    await holdingTask;
  });

  test("serializes same-run quota accounting across independent coordinators", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "catalog-asset-coordination-"));
    const firstCoordinator = createIndependentCoordinator();
    const secondCoordinator = createIndependentCoordinator();
    coordinators.add(firstCoordinator);
    coordinators.add(secondCoordinator);

    const maxRunBytes = 18_000;
    const seedStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: firstCoordinator.coordinator,
      lockTimeoutMs: 5_000,
      maxRunBytes,
    });
    let releaseFirstStage: (() => void) | null = null;
    let firstStagePaused = false;
    const firstStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: firstCoordinator.coordinator,
      lockTimeoutMs: 5_000,
      maxRunBytes,
      onStageWriteReady() {
        firstStagePaused = true;
        return new Promise<void>((resolve) => {
          releaseFirstStage = resolve;
        });
      },
    });
    const secondStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: secondCoordinator.coordinator,
      lockTimeoutMs: 5_000,
      maxRunBytes,
    });

    const seeded = await seedStorage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 10 }),
      contentType: "image/png",
      originalFileName: "seed.png",
      runId: "quota-run",
      skuCode: "TZX-001",
    });
    const secondBytes = await createImageBuffer("png", { g: 30 });
    const thirdBytes = await createImageBuffer("png", { r: 50 });
    const fillerSize =
      maxRunBytes - seeded.byteSize - Math.max(secondBytes.byteLength, thirdBytes.byteLength) - 16;
    await writeFile(join(assetRoot, "temporary", "quota-run", "filler.bin"), Buffer.alloc(fillerSize));

    const secondStage = firstStorage.stageCatalogAsset({
      bytes: secondBytes,
      contentType: "image/png",
      originalFileName: "second.png",
      runId: "quota-run",
      skuCode: "TZX-002",
    });

    while (!firstStagePaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const thirdStage = secondStorage.stageCatalogAsset({
      bytes: thirdBytes,
      contentType: "image/png",
      originalFileName: "third.png",
      runId: "quota-run",
      skuCode: "TZX-003",
    });

    const continueFirstStage = releaseFirstStage as (() => void) | null;
    if (continueFirstStage) {
      continueFirstStage();
    }
    const settled = await Promise.allSettled([secondStage, thirdStage]);
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await sumDirectoryBytes(join(assetRoot, "temporary", "quota-run"))).toBeLessThanOrEqual(maxRunBytes);
  });

  test("aborts a staged write after the lock-holding connection closes and a waiter reclaims the run lock", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "catalog-asset-coordination-"));
    const firstCoordinator = createIndependentCoordinator();
    const secondCoordinator = createIndependentCoordinator();
    coordinators.add(firstCoordinator);
    coordinators.add(secondCoordinator);

    let releaseFirstWrite: (() => void) | null = null;
    let firstWritePaused = false;
    const firstStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: firstCoordinator.coordinator,
      onTemporaryWriteProgress({ bytesWritten, totalBytes }) {
        if (!firstWritePaused && bytesWritten > 0 && bytesWritten < totalBytes) {
          firstWritePaused = true;
          return new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const secondStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: secondCoordinator.coordinator,
      targetWriteChunkSize: 32,
    });

    const firstStage = firstStorage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 1, g: 2, r: 3, width: 64, height: 64 }),
      contentType: "image/png",
      originalFileName: "first-stage.png",
      runId: "connection-loss-run",
      skuCode: "TZX-001",
    });

    while (!firstWritePaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondStage = secondStorage.stageCatalogAsset({
      bytes: await createImageBuffer("png", { b: 4, g: 5, r: 6, width: 64, height: 64 }),
      contentType: "image/png",
      originalFileName: "second-stage.png",
      runId: "connection-loss-run",
      skuCode: "TZX-002",
    });

    await firstCoordinator.client.end({ timeout: 0 });
    coordinators.delete(firstCoordinator);

    const continueFirstWrite = releaseFirstWrite as (() => void) | null;
    if (continueFirstWrite) {
      continueFirstWrite();
    }

    await expect(firstStage).rejects.toThrow(/coordination|lock was lost|connection/i);
    const secondManifest = await secondStage;
    const runEntries = await readdir(join(assetRoot, "temporary", "connection-loss-run"));
    expect(runEntries.filter((entry) => entry.startsWith(".catalog-asset-stage-"))).toEqual([]);
    expect(runEntries.filter((entry) => entry.endsWith(".png"))).toEqual([
      `${secondManifest.contentSha256}.png`,
    ]);
  });

  test("deduplicates concurrent same-digest commits across independent coordinators", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "catalog-asset-coordination-"));
    const firstCoordinator = createIndependentCoordinator();
    const secondCoordinator = createIndependentCoordinator();
    coordinators.add(firstCoordinator);
    coordinators.add(secondCoordinator);

    let releaseFirstCommit: (() => void) | null = null;
    let firstCommitPaused = false;
    const firstStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: firstCoordinator.coordinator,
      lockTimeoutMs: 5_000,
      onFinalPublishReady() {
        firstCommitPaused = true;
        return new Promise<void>((resolve) => {
          releaseFirstCommit = resolve;
        });
      },
    });
    const secondStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: secondCoordinator.coordinator,
      lockTimeoutMs: 5_000,
    });

    const bytes = await createImageBuffer("webp");
    const firstManifest = await firstStorage.stageCatalogAsset({
      bytes,
      contentType: "image/webp",
      originalFileName: "first.webp",
      runId: "digest-run-a",
      skuCode: "TZX-001",
    });
    const secondManifest = await secondStorage.stageCatalogAsset({
      bytes,
      contentType: "image/webp",
      originalFileName: "second.webp",
      runId: "digest-run-b",
      skuCode: "TZX-002",
    });

    const firstCommit = firstStorage.commitCatalogAsset(firstManifest);
    while (!firstCommitPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondCommit = secondStorage.commitCatalogAsset(secondManifest);
    const continueFirstCommit = releaseFirstCommit as (() => void) | null;
    if (continueFirstCommit) {
      continueFirstCommit();
    }

    const [firstKey, secondKey] = await Promise.all([firstCommit, secondCommit]);
    expect(firstKey).toBe(secondKey);
    expect((await readdir(join(assetRoot, dirname(firstKey)))).filter((entry) => entry.startsWith("."))).toEqual([]);
  });

  test("aborts a fallback publish after the lock-holding connection closes and a waiter commits the digest", async () => {
    assetRoot = await mkdtemp(join(tmpdir(), "catalog-asset-coordination-"));
    const firstCoordinator = createIndependentCoordinator();
    const secondCoordinator = createIndependentCoordinator();
    coordinators.add(firstCoordinator);
    coordinators.add(secondCoordinator);

    let releaseFirstCopy: (() => void) | null = null;
    let firstCopyPaused = false;
    const firstStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: firstCoordinator.coordinator,
      onStorageLink() {
        throw unsupportedLinkError();
      },
      onTargetWriteProgress({ bytesWritten, totalBytes }) {
        if (!firstCopyPaused && bytesWritten > 0 && bytesWritten < totalBytes) {
          firstCopyPaused = true;
          return new Promise<void>((resolve) => {
            releaseFirstCopy = resolve;
          });
        }
      },
      targetWriteChunkSize: 32,
    });
    const secondStorage = createCatalogAssetStorage({
      assetDir: assetRoot,
      coordinator: secondCoordinator.coordinator,
      onStorageLink() {
        throw unsupportedLinkError();
      },
      targetWriteChunkSize: 32,
    });

    const bytes = await createImageBuffer("webp");
    const firstManifest = await firstStorage.stageCatalogAsset({
      bytes,
      contentType: "image/webp",
      originalFileName: "first.webp",
      runId: "connection-loss-digest-a",
      skuCode: "TZX-001",
    });
    const secondManifest = await secondStorage.stageCatalogAsset({
      bytes,
      contentType: "image/webp",
      originalFileName: "second.webp",
      runId: "connection-loss-digest-b",
      skuCode: "TZX-002",
    });
    const expectedStorageKey = `sha256/${firstManifest.contentSha256.slice(0, 2)}/${firstManifest.contentSha256}.webp`;

    const firstCommit = firstStorage.commitCatalogAsset(firstManifest);
    while (!firstCopyPaused) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondCommit = secondStorage.commitCatalogAsset(secondManifest);
    await firstCoordinator.client.end({ timeout: 0 });
    coordinators.delete(firstCoordinator);

    const continueFirstCopy = releaseFirstCopy as (() => void) | null;
    if (continueFirstCopy) {
      continueFirstCopy();
    }

    await expect(firstCommit).rejects.toThrow(/coordination|lock was lost|connection/i);
    await expect(secondCommit).resolves.toBe(expectedStorageKey);
    expect((await readdir(join(assetRoot, dirname(expectedStorageKey)))).filter((entry) => entry.startsWith("."))).toEqual([]);
  });
});
