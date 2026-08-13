import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import sharp from "sharp";

import type { TemporaryAssetManifest } from "./cargo-types";
import {
  createPostgresCatalogAssetCoordinator,
  type CatalogAssetCoordinator,
} from "./asset-coordination";

const DEFAULT_CATALOG_ASSET_DIR = "/app/data/catalog-assets";
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PIXEL_COUNT = 25_000_000;
const DEFAULT_MAX_RUN_BYTES = 1024 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_TARGET_WRITE_CHUNK_SIZE = 64 * 1024;
const DEFAULT_TEMPORARY_FILE_STALE_MS = 60_000;
const STAGING_TEMP_FILE_PATTERN = /^\.catalog-asset-stage-(\d+)-([0-9a-f-]{36})\.tmp$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TEMPORARY_KEY_PATTERN =
  /^temporary\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([0-9a-f]{64})\.(jpg|png|webp)$/;
const STORAGE_KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.(jpg|png|webp)$/;
const READ_NOFOLLOW_FLAGS =
  constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const WRITE_NOFOLLOW_FLAGS =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const HARD_LINK_UNSUPPORTED_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"]);

type ImageMimeType = TemporaryAssetManifest["mimeType"];
type ImageExtension = "jpg" | "png" | "webp";
type DirectorySyncReason = "cleanup" | "publish";
type AssetRootState = {
  absoluteRoot: string;
  realRoot: string;
};
type TargetWriteProgress = {
  bytesWritten: number;
  targetPath: string;
  totalBytes: number;
};
type TargetCleanupContext = {
  targetPath: string;
};
type FileIdentity = {
  birthtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};
type CatalogAssetStorageOptions = {
  assetDir?: string;
  coordinator?: CatalogAssetCoordinator;
  lockTimeoutMs?: number;
  maxFileBytes?: number;
  maxPixelCount?: number;
  maxRunBytes?: number;
  onDirectorySync?: ((path: string, reason: DirectorySyncReason) => Promise<void> | void) | undefined;
  onFinalPublishReady?: (() => Promise<void> | void) | undefined;
  onStageWriteReady?: (() => Promise<void> | void) | undefined;
  onStorageLink?: ((temporaryPath: string, targetPath: string) => Promise<void> | void) | undefined;
  onTargetCleanup?: ((context: TargetCleanupContext) => Promise<void> | void) | undefined;
  onTargetWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  onTemporaryWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  targetWriteChunkSize?: number;
  temporaryFileStaleMs?: number;
};
type PublishBytesOptions = {
  assertCanContinue?: (() => Promise<void>) | undefined;
  bytes: Uint8Array;
  expectedDigest?: string;
  expectedMimeType?: ImageMimeType;
  onReady?: (() => Promise<void> | void) | undefined;
  onWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  tempFileName: string;
  targetPath: string;
};
type PublishBytesResult = {
  published: boolean;
};
type ManagedFile = {
  handle: FileHandle;
  path: string;
};
type StorageDependencies = {
  assetDir: string;
  coordinator: CatalogAssetCoordinator;
  maxFileBytes: number;
  maxPixelCount: number;
  maxRunBytes: number;
  onDirectorySync?: ((path: string, reason: DirectorySyncReason) => Promise<void> | void) | undefined;
  onFinalPublishReady?: (() => Promise<void> | void) | undefined;
  onStageWriteReady?: (() => Promise<void> | void) | undefined;
  onStorageLink?: ((temporaryPath: string, targetPath: string) => Promise<void> | void) | undefined;
  onTargetCleanup?: ((context: TargetCleanupContext) => Promise<void> | void) | undefined;
  onTargetWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  onTemporaryWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  targetWriteChunkSize: number;
  temporaryFileStaleMs: number;
};

class CatalogAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogAssetError";
  }
}

class CatalogAssetConflictError extends CatalogAssetError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogAssetConflictError";
  }
}

function createStagingTempFileName(createdAtMs: number) {
  return `.catalog-asset-stage-${createdAtMs}-${crypto.randomUUID()}.tmp`;
}

function createFinalTempFileName(contentSha256: string, createdAtMs: number) {
  return `.catalog-asset-digest-${contentSha256}-${createdAtMs}-${crypto.randomUUID()}.tmp`;
}

function createFinalTempFilePattern(contentSha256: string) {
  return new RegExp(`^\\.catalog-asset-digest-${contentSha256}-(\\d+)-([0-9a-f-]{36})\\.tmp$`);
}

function toComparablePath(input: string) {
  return process.platform === "win32" ? input.toLowerCase() : input;
}

function assertRunId(runId: string) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new CatalogAssetError("run id must be a simple relative identifier");
  }
}

function extensionForMimeType(mimeType: ImageMimeType): ImageExtension {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}

function mimeTypeForExtension(extension: ImageExtension): ImageMimeType {
  switch (extension) {
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
  }
}

function detectMagicMimeType(bytes: Uint8Array): ImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

function assertContainedPath(root: string, candidate: string, label: string) {
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..\\`) ||
    relativePath.startsWith("../") ||
    resolve(root, relativePath) !== candidate
  ) {
    throw new CatalogAssetError(`${label} resolves outside CATALOG_ASSET_DIR`);
  }
}

function assertInsideRealRoot(realRoot: string, candidateRealPath: string, label: string) {
  const comparableRoot = toComparablePath(realRoot);
  const comparableCandidate = toComparablePath(candidateRealPath);
  if (
    comparableCandidate !== comparableRoot &&
    !comparableCandidate.startsWith(`${comparableRoot}\\`) &&
    !comparableCandidate.startsWith(`${comparableRoot}/`)
  ) {
    throw new CatalogAssetError(`${label} resolves outside CATALOG_ASSET_DIR`);
  }
}

async function getAssetRootState(assetDir: string): Promise<AssetRootState> {
  const absoluteRoot = resolve(assetDir);
  await mkdir(absoluteRoot, { recursive: true });
  return {
    absoluteRoot,
    realRoot: await realpath(absoluteRoot),
  };
}

async function assertExistingAncestorInsideRoot(
  state: AssetRootState,
  startingPath: string,
  label: string,
): Promise<void> {
  let currentPath = startingPath;
  while (true) {
    assertContainedPath(state.absoluteRoot, currentPath, label);

    const currentStats = await lstat(currentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (currentStats) {
      const currentRealPath = await realpath(currentPath);
      assertInsideRealRoot(state.realRoot, currentRealPath, label);
      return;
    }

    if (currentPath === state.absoluteRoot) {
      return;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return;
    }
    currentPath = parentPath;
  }
}

async function ensureManagedDirectory(
  state: AssetRootState,
  directoryPath: string,
  options?: { create?: boolean; label?: string },
) {
  const label = options?.label ?? "asset path";
  assertContainedPath(state.absoluteRoot, directoryPath, label);

  if (options?.create ?? true) {
    await mkdir(directoryPath, { recursive: true });
  }

  const realDirectoryPath = await realpath(directoryPath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await assertExistingAncestorInsideRoot(state, dirname(directoryPath), label);
    throw error;
  });
  assertInsideRealRoot(state.realRoot, realDirectoryPath, label);
}

async function resolveManagedFilePath(
  state: AssetRootState,
  relativeKey: string,
  label: string,
  options?: { createParent?: boolean },
): Promise<string> {
  const absolutePath = resolve(state.absoluteRoot, relativeKey);
  assertContainedPath(state.absoluteRoot, absolutePath, label);
  await ensureManagedDirectory(state, dirname(absolutePath), {
    create: options?.createParent ?? true,
    label,
  });
  return absolutePath;
}

function assertValidTemporaryKey(temporaryKey: string) {
  const match = TEMPORARY_KEY_PATTERN.exec(temporaryKey);
  if (!match) {
    throw new CatalogAssetError("temporary key is invalid");
  }

  return {
    contentSha256: match[2],
    extension: match[3] as ImageExtension,
    runId: match[1],
  };
}

function assertValidStorageKey(storageKey: string) {
  const match = STORAGE_KEY_PATTERN.exec(storageKey);
  if (!match) {
    throw new CatalogAssetError("storage key is invalid");
  }

  return {
    contentSha256: match[2],
    extension: match[3] as ImageExtension,
  };
}

async function safeUnlink(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

async function safeClose(handle: FileHandle | null | undefined) {
  if (!handle) {
    return;
  }
  await handle.close().catch(() => undefined);
}

function toFileIdentity(stats: Stats): FileIdentity {
  return {
    birthtimeMs: stats.birthtimeMs,
    ctimeMs: stats.ctimeMs,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

function hasStableDeviceInode(identity: FileIdentity) {
  return identity.dev !== 0 && identity.ino !== 0;
}

function fileIdentityMatches(expected: FileIdentity, actual: FileIdentity) {
  if (hasStableDeviceInode(expected) && hasStableDeviceInode(actual)) {
    return expected.dev === actual.dev && expected.ino === actual.ino;
  }

  if (process.platform === "win32") {
    return (
      expected.birthtimeMs === actual.birthtimeMs &&
      expected.ctimeMs === actual.ctimeMs &&
      expected.mtimeMs === actual.mtimeMs &&
      expected.size === actual.size
    );
  }

  return false;
}

async function safeUnlinkOwnedPath(path: string, expectedIdentity: FileIdentity | null): Promise<boolean> {
  if (!expectedIdentity) {
    return false;
  }

  const currentStats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!currentStats || !currentStats.isFile()) {
    return false;
  }
  if (!fileIdentityMatches(expectedIdentity, toFileIdentity(currentStats))) {
    return false;
  }

  await safeUnlink(path);
  return true;
}

async function validateImageBytes(
  bytes: Uint8Array,
  limits: Pick<StorageDependencies, "maxFileBytes" | "maxPixelCount">,
  expectedMimeType?: ImageMimeType,
): Promise<{ contentSha256: string; extension: ImageExtension; mimeType: ImageMimeType }> {
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new CatalogAssetError("catalog asset must be 8 MiB or smaller");
  }

  const detectedMimeType = detectMagicMimeType(bytes);
  if (!detectedMimeType) {
    throw new CatalogAssetError("unsupported image format");
  }

  if (expectedMimeType && expectedMimeType !== detectedMimeType) {
    throw new CatalogAssetError("declared content type does not match image bytes");
  }

  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new CatalogAssetError("image dimensions could not be decoded");
  }

  if (metadata.width * metadata.height > limits.maxPixelCount) {
    throw new CatalogAssetError("catalog asset exceeds the 25,000,000 pixel limit");
  }

  await sharp(bytes, { failOn: "error" }).stats();

  return {
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    extension: extensionForMimeType(detectedMimeType),
    mimeType: detectedMimeType,
  };
}

async function sumDirectoryBytes(
  directoryPath: string,
  assertCanContinue?: (() => Promise<void>) | undefined,
): Promise<number> {
  await assertCanContinue?.();
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );

  let total = 0;
  for (const entry of entries) {
    await assertCanContinue?.();
    const absolutePath = join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CatalogAssetError("asset path resolves outside CATALOG_ASSET_DIR");
    }
    if (entry.isDirectory()) {
      total += await sumDirectoryBytes(absolutePath, assertCanContinue);
      continue;
    }
    if (entry.isFile()) {
      await assertCanContinue?.();
      total += (await stat(absolutePath)).size;
    }
  }

  return total;
}

async function writeExclusiveFile(
  path: string,
  bytes: Uint8Array,
  options?: {
    assertCanContinue?: (() => Promise<void>) | undefined;
    chunkSize?: number | undefined;
    onWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  },
) {
  let handle: FileHandle | null = null;
  try {
    await options?.assertCanContinue?.();
    handle = await open(path, WRITE_NOFOLLOW_FLAGS, 0o600);
    const chunkSize = Math.max(1, options?.chunkSize ?? bytes.byteLength);
    let bytesWritten = 0;
    while (bytesWritten < bytes.byteLength) {
      await options?.assertCanContinue?.();

      const nextBytesWritten = Math.min(bytesWritten + chunkSize, bytes.byteLength);
      const chunk = Buffer.from(bytes.subarray(bytesWritten, nextBytesWritten));
      await handle.write(chunk, 0, chunk.byteLength, bytesWritten);
      bytesWritten = nextBytesWritten;

      await options?.onWriteProgress?.({
        bytesWritten,
        targetPath: path,
        totalBytes: bytes.byteLength,
      });
      await options?.assertCanContinue?.();
    }

    await handle.sync();
    await options?.assertCanContinue?.();
  } catch (error) {
    await safeClose(handle);
    throw error;
  }
  await safeClose(handle);
}

async function syncDirectory(
  directoryPath: string,
  dependencies: StorageDependencies,
  reason: DirectorySyncReason,
  assertCanContinue?: (() => Promise<void>) | undefined,
) {
  await assertCanContinue?.();
  await dependencies.onDirectorySync?.(directoryPath, reason);

  let handle: FileHandle | null = null;
  try {
    await assertCanContinue?.();
    handle = await open(directoryPath, constants.O_RDONLY);
    await handle.sync();
    await assertCanContinue?.();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (
      !(
        process.platform !== "linux" &&
        ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(nodeError.code ?? "")
      )
    ) {
      throw error;
    }
  } finally {
    await safeClose(handle);
  }
}

async function renameWithinRoot(
  state: AssetRootState,
  fromPath: string,
  toPath: string,
  label: string,
  assertCanContinue?: (() => Promise<void>) | undefined,
): Promise<boolean> {
  await assertCanContinue?.();
  assertContainedPath(state.absoluteRoot, fromPath, label);
  assertContainedPath(state.absoluteRoot, toPath, label);
  await ensureManagedDirectory(state, dirname(toPath), { create: true, label });

  try {
    await assertCanContinue?.();
    await rename(fromPath, toPath);
    await assertCanContinue?.();
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function openManagedFile(
  state: AssetRootState,
  relativeKey: string,
  label: string,
  assertCanContinue?: (() => Promise<void>) | undefined,
): Promise<ManagedFile> {
  await assertCanContinue?.();
  const absolutePath = resolve(state.absoluteRoot, relativeKey);
  assertContainedPath(state.absoluteRoot, absolutePath, label);
  await assertExistingAncestorInsideRoot(state, dirname(absolutePath), label);

  await assertCanContinue?.();
  const handle = await open(absolutePath, READ_NOFOLLOW_FLAGS);
  try {
    await assertCanContinue?.();
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new CatalogAssetError(`${label} is not a file`);
    }
    const realFilePath = await realpath(absolutePath);
    assertInsideRealRoot(state.realRoot, realFilePath, label);
  } catch (error) {
    await safeClose(handle);
    throw error;
  }

  return {
    handle,
    path: absolutePath,
  };
}

async function readManagedFile(
  state: AssetRootState,
  relativeKey: string,
  label: string,
  assertCanContinue?: (() => Promise<void>) | undefined,
): Promise<Uint8Array> {
  const managedFile = await openManagedFile(state, relativeKey, label, assertCanContinue);
  try {
    await assertCanContinue?.();
    return new Uint8Array(await managedFile.handle.readFile());
  } finally {
    await safeClose(managedFile.handle);
  }
}

async function reclaimStaleTemporaryFiles(
  state: AssetRootState,
  dependencies: StorageDependencies,
  directoryPath: string,
  pattern: RegExp,
  label: string,
  assertCanContinue: () => Promise<void>,
) {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );

  let cleanedAny = false;
  for (const entry of entries) {
    await assertCanContinue();

    const match = pattern.exec(entry.name);
    if (!match) {
      continue;
    }

    const createdAtMs = Number(match[1]);
    if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs <= dependencies.temporaryFileStaleMs) {
      continue;
    }

    const absolutePath = join(directoryPath, entry.name);
    assertContainedPath(state.absoluteRoot, absolutePath, label);
    const entryStats = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!entryStats || entryStats.isSymbolicLink() || !entryStats.isFile()) {
      continue;
    }

    const quarantinePath = join(
      directoryPath,
      `.catalog-asset-quarantine-${createdAtMs}-${crypto.randomUUID()}.tmp`,
    );
    const moved = await renameWithinRoot(state, absolutePath, quarantinePath, label, assertCanContinue);
    if (!moved) {
      continue;
    }

    await safeUnlink(quarantinePath);
    cleanedAny = true;
  }

  if (cleanedAny) {
    await assertCanContinue();
    await syncDirectory(directoryPath, dependencies, "cleanup", assertCanContinue);
  }
}

async function verifyExistingPublishedTarget(
  state: AssetRootState,
  dependencies: StorageDependencies,
  options: Pick<PublishBytesOptions, "expectedDigest" | "expectedMimeType" | "targetPath">,
  assertCanContinue?: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!options.expectedDigest || !options.expectedMimeType) {
    return;
  }

  const relativeKey = relative(state.absoluteRoot, options.targetPath).replaceAll("\\", "/");
  const existingBytes = await readManagedFile(state, relativeKey, "storage key", assertCanContinue);
  const validation = await validateImageBytes(existingBytes, dependencies, options.expectedMimeType);
  if (validation.contentSha256 !== options.expectedDigest) {
    throw new CatalogAssetConflictError("catalog asset digest target conflicts with different bytes");
  }
}

async function publishBytesAtomically(
  state: AssetRootState,
  dependencies: StorageDependencies,
  options: PublishBytesOptions,
): Promise<PublishBytesResult> {
  const finalDirectory = dirname(options.targetPath);
  await ensureManagedDirectory(state, finalDirectory, {
    create: true,
    label: options.expectedDigest ? "storage key" : "temporary asset path",
  });

  const tempPath = join(finalDirectory, options.tempFileName);
  assertContainedPath(
    state.absoluteRoot,
    tempPath,
    options.expectedDigest ? "storage key" : "temporary asset path",
  );

  try {
    await options.assertCanContinue?.();
    await writeExclusiveFile(tempPath, options.bytes, {
      assertCanContinue: options.assertCanContinue,
      chunkSize: dependencies.targetWriteChunkSize,
      onWriteProgress: options.onWriteProgress,
    });
    await options.assertCanContinue?.();
    await options.onReady?.();
    await options.assertCanContinue?.();

    try {
      if (options.expectedDigest && dependencies.onStorageLink) {
        await options.assertCanContinue?.();
        await dependencies.onStorageLink(tempPath, options.targetPath);
      } else if (options.expectedDigest) {
        await options.assertCanContinue?.();
        await link(tempPath, options.targetPath);
        await options.assertCanContinue?.();
      } else {
        const moved = await renameWithinRoot(
          state,
          tempPath,
          options.targetPath,
          "temporary asset path",
          options.assertCanContinue,
        );
        if (!moved) {
          throw new CatalogAssetError("temporary asset publish source disappeared before rename");
        }
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (options.expectedDigest && HARD_LINK_UNSUPPORTED_CODES.has(nodeError.code ?? "")) {
        let targetIdentity: FileIdentity | null = null;
        try {
          await writeExclusiveFile(options.targetPath, options.bytes, {
            assertCanContinue: options.assertCanContinue,
            chunkSize: dependencies.targetWriteChunkSize,
            onWriteProgress: options.onWriteProgress,
          });
          await options.assertCanContinue?.();
          targetIdentity = toFileIdentity(await stat(options.targetPath));
        } catch (fallbackError) {
          const fallbackNodeError = fallbackError as NodeJS.ErrnoException;
          if (fallbackNodeError.code === "EEXIST") {
            await verifyExistingPublishedTarget(state, dependencies, options, options.assertCanContinue);
            return { published: false };
          }

          if (targetIdentity) {
            await dependencies.onTargetCleanup?.({ targetPath: options.targetPath });
            const removedOwnedTarget = await safeUnlinkOwnedPath(options.targetPath, targetIdentity);
            if (removedOwnedTarget) {
              await syncDirectory(finalDirectory, dependencies, "cleanup");
            }
          }
          throw fallbackError;
        }

        try {
          await syncDirectory(finalDirectory, dependencies, "publish", options.assertCanContinue);
        } catch (syncError) {
          await dependencies.onTargetCleanup?.({ targetPath: options.targetPath });
          const removedOwnedTarget = await safeUnlinkOwnedPath(options.targetPath, targetIdentity);
          if (removedOwnedTarget) {
            await syncDirectory(finalDirectory, dependencies, "cleanup", options.assertCanContinue);
          }
          throw syncError;
        }
        return { published: true };
      }

      if (nodeError.code === "EEXIST" && options.expectedDigest) {
        await verifyExistingPublishedTarget(state, dependencies, options, options.assertCanContinue);
        return { published: false };
      }

      throw error;
    }

    await syncDirectory(finalDirectory, dependencies, "publish", options.assertCanContinue);
    return { published: true };
  } finally {
    const tempRemoved = await unlink(tempPath)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      });
    if (tempRemoved) {
      await syncDirectory(finalDirectory, dependencies, "cleanup", options.assertCanContinue);
    }
  }
}

export function createCatalogAssetStorage(options: CatalogAssetStorageOptions = {}) {
  const dependencies: StorageDependencies = {
    assetDir: options.assetDir?.trim() || process.env.CATALOG_ASSET_DIR?.trim() || DEFAULT_CATALOG_ASSET_DIR,
    coordinator:
      options.coordinator ??
      createPostgresCatalogAssetCoordinator({
        lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      }),
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxPixelCount: options.maxPixelCount ?? DEFAULT_MAX_PIXEL_COUNT,
    maxRunBytes: options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES,
    onDirectorySync: options.onDirectorySync,
    onFinalPublishReady: options.onFinalPublishReady,
    onStageWriteReady: options.onStageWriteReady,
    onStorageLink: options.onStorageLink,
    onTargetCleanup: options.onTargetCleanup,
    onTargetWriteProgress: options.onTargetWriteProgress,
    onTemporaryWriteProgress: options.onTemporaryWriteProgress,
    targetWriteChunkSize: options.targetWriteChunkSize ?? DEFAULT_TARGET_WRITE_CHUNK_SIZE,
    temporaryFileStaleMs: options.temporaryFileStaleMs ?? DEFAULT_TEMPORARY_FILE_STALE_MS,
  };

  async function stageCatalogAsset(input: {
    bytes: Uint8Array;
    contentType: string;
    originalFileName: string;
    runId: string;
    skuCode: string;
  }): Promise<TemporaryAssetManifest> {
    assertRunId(input.runId);

    const validation = await validateImageBytes(
      input.bytes,
      dependencies,
      input.contentType as ImageMimeType,
    );
    const temporaryKey = `temporary/${input.runId}/${validation.contentSha256}.${validation.extension}`;
    const state = await getAssetRootState(dependencies.assetDir);
    const runDirectoryPath = resolve(state.absoluteRoot, "temporary", input.runId);
    const temporaryPath = await resolveManagedFilePath(state, temporaryKey, "temporary asset path");

    await dependencies.coordinator.withRunLock(input.runId, async (guard) => {
      await reclaimStaleTemporaryFiles(
        state,
        dependencies,
        runDirectoryPath,
        STAGING_TEMP_FILE_PATTERN,
        "temporary asset path",
        () => guard.assertHeld(),
      );

      try {
        const existingBytes = await readManagedFile(
          state,
          temporaryKey,
          "temporary asset path",
          () => guard.assertHeld(),
        );
        const existingValidation = await validateImageBytes(
          existingBytes,
          dependencies,
          validation.mimeType,
        );
        if (existingValidation.contentSha256 !== validation.contentSha256) {
          throw new CatalogAssetError("temporary asset digest does not match the manifest");
        }
        return;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (
          !(error instanceof CatalogAssetError && /manifest/.test(error.message)) &&
          nodeError.code !== "ENOENT"
        ) {
          throw error;
        }
      }

      await guard.assertHeld();
      const currentRunBytes = await sumDirectoryBytes(runDirectoryPath, () => guard.assertHeld());
      await guard.assertHeld();
      if (currentRunBytes + input.bytes.byteLength > dependencies.maxRunBytes) {
        throw new CatalogAssetError("catalog migration assets must stay within the 1 GiB per-run limit");
      }

      await dependencies.onStageWriteReady?.();
      await guard.assertHeld();

      await publishBytesAtomically(state, dependencies, {
        assertCanContinue: () => guard.assertHeld(),
        bytes: input.bytes,
        onWriteProgress: dependencies.onTemporaryWriteProgress,
        tempFileName: createStagingTempFileName(Date.now()),
        targetPath: temporaryPath,
      });
      await guard.assertHeld();
    });

    return {
      byteSize: input.bytes.byteLength,
      contentSha256: validation.contentSha256,
      mimeType: validation.mimeType,
      originalFileName: input.originalFileName,
      skuCode: input.skuCode,
      temporaryKey,
    };
  }

  async function commitCatalogAsset(manifest: TemporaryAssetManifest): Promise<string> {
    if (!DIGEST_PATTERN.test(manifest.contentSha256)) {
      throw new CatalogAssetError("content sha256 is invalid");
    }

    const temporary = assertValidTemporaryKey(manifest.temporaryKey);
    const expectedExtension = extensionForMimeType(manifest.mimeType);
    if (
      temporary.contentSha256 !== manifest.contentSha256 ||
      temporary.extension !== expectedExtension
    ) {
      throw new CatalogAssetError("temporary manifest does not match the content digest or mime type");
    }

    const state = await getAssetRootState(dependencies.assetDir);
    const storageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.${expectedExtension}`;
    const finalPath = await resolveManagedFilePath(state, storageKey, "storage key");
    const finalDirectory = dirname(finalPath);

    return await dependencies.coordinator.withDigestLock(manifest.contentSha256, async (guard) => {
      await reclaimStaleTemporaryFiles(
        state,
        dependencies,
        finalDirectory,
        createFinalTempFilePattern(manifest.contentSha256),
        "storage key",
        () => guard.assertHeld(),
      );

      await guard.assertHeld();
      const stagedBytes = await readManagedFile(
        state,
        manifest.temporaryKey,
        "temporary asset path",
        () => guard.assertHeld(),
      );
      await guard.assertHeld();
      if (stagedBytes.byteLength !== manifest.byteSize) {
        throw new CatalogAssetError("temporary asset size does not match the manifest");
      }

      const validation = await validateImageBytes(stagedBytes, dependencies, manifest.mimeType);
      if (validation.contentSha256 !== manifest.contentSha256) {
        throw new CatalogAssetError("temporary asset digest does not match the manifest");
      }

      await publishBytesAtomically(state, dependencies, {
        assertCanContinue: () => guard.assertHeld(),
        bytes: stagedBytes,
        expectedDigest: manifest.contentSha256,
        expectedMimeType: manifest.mimeType,
        onReady: dependencies.onFinalPublishReady,
        onWriteProgress: dependencies.onTargetWriteProgress,
        tempFileName: createFinalTempFileName(manifest.contentSha256, Date.now()),
        targetPath: finalPath,
      });
      await guard.assertHeld();

      const temporaryPath = resolve(state.absoluteRoot, manifest.temporaryKey);
      await guard.assertHeld();
      const temporaryRemoved = await unlink(temporaryPath)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return false;
          }
          throw error;
        });
      if (temporaryRemoved) {
        await syncDirectory(dirname(temporaryPath), dependencies, "cleanup", () => guard.assertHeld());
      }
      await guard.assertHeld();

      return storageKey;
    });
  }

  async function discardStagedAssets(runId: string): Promise<void> {
    assertRunId(runId);

    const state = await getAssetRootState(dependencies.assetDir);
    const runDirectoryPath = resolve(state.absoluteRoot, "temporary", runId);
    assertContainedPath(state.absoluteRoot, runDirectoryPath, "run directory");

    await dependencies.coordinator.withRunLock(runId, async (guard) => {
      const runDirectory = await lstat(runDirectoryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (!runDirectory) {
        return;
      }
      if (runDirectory.isSymbolicLink()) {
        throw new CatalogAssetError("run directory resolves outside CATALOG_ASSET_DIR");
      }

      await guard.assertHeld();
      await rm(runDirectoryPath, { force: true, recursive: true });
      await syncDirectory(dirname(runDirectoryPath), dependencies, "cleanup", () => guard.assertHeld());
      await guard.assertHeld();
    });
  }

  async function openCatalogAsset(
    storageKey: string,
  ): Promise<{ bytes: Uint8Array; contentType: ImageMimeType }> {
    const parsed = assertValidStorageKey(storageKey);
    const state = await getAssetRootState(dependencies.assetDir);
    const bytes = await readManagedFile(state, storageKey, "storage key");
    const validation = await validateImageBytes(
      bytes,
      dependencies,
      mimeTypeForExtension(parsed.extension),
    );
    if (validation.contentSha256 !== parsed.contentSha256) {
      throw new CatalogAssetError("stored catalog asset digest does not match the storage key");
    }

    return {
      bytes,
      contentType: validation.mimeType,
    };
  }

  return {
    commitCatalogAsset,
    discardStagedAssets,
    openCatalogAsset,
    stageCatalogAsset,
  };
}

export async function stageCatalogAsset(
  ...args: Parameters<ReturnType<typeof createCatalogAssetStorage>["stageCatalogAsset"]>
) {
  return await createCatalogAssetStorage().stageCatalogAsset(...args);
}

export async function commitCatalogAsset(
  ...args: Parameters<ReturnType<typeof createCatalogAssetStorage>["commitCatalogAsset"]>
) {
  return await createCatalogAssetStorage().commitCatalogAsset(...args);
}

export async function discardStagedAssets(
  ...args: Parameters<ReturnType<typeof createCatalogAssetStorage>["discardStagedAssets"]>
) {
  return await createCatalogAssetStorage().discardStagedAssets(...args);
}

export async function openCatalogAsset(
  ...args: Parameters<ReturnType<typeof createCatalogAssetStorage>["openCatalogAsset"]>
) {
  return await createCatalogAssetStorage().openCatalogAsset(...args);
}
