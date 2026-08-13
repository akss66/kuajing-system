import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import sharp from "sharp";

import type { TemporaryAssetManifest } from "./cargo-types";

const DEFAULT_CATALOG_ASSET_DIR = "/app/data/catalog-assets";
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PIXEL_COUNT = 25_000_000;
const DEFAULT_MAX_RUN_BYTES = 1024 * 1024 * 1024;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
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

type ImageMimeType = TemporaryAssetManifest["mimeType"];
type ImageExtension = "jpg" | "png" | "webp";
type AssetRootState = {
  absoluteRoot: string;
  realRoot: string;
};
type CatalogAssetStorageOptions = {
  assetDir?: string;
  lockRetryDelayMs?: number;
  lockStaleMs?: number;
  lockTimeoutMs?: number;
  maxFileBytes?: number;
  maxPixelCount?: number;
  maxRunBytes?: number;
  onFinalPublishReady?: (() => Promise<void> | void) | undefined;
};
type PublishBytesOptions = {
  bytes: Uint8Array;
  expectedDigest?: string;
  expectedMimeType?: ImageMimeType;
  onReady?: (() => Promise<void> | void) | undefined;
  targetPath: string;
};
type PublishBytesResult = {
  published: boolean;
};
type ManagedFile = {
  handle: FileHandle;
  path: string;
};
type StorageDependencies = Required<
  Pick<
    CatalogAssetStorageOptions,
    | "assetDir"
    | "lockRetryDelayMs"
    | "lockStaleMs"
    | "lockTimeoutMs"
    | "maxFileBytes"
    | "maxPixelCount"
    | "maxRunBytes"
  >
> & {
  onFinalPublishReady?: (() => Promise<void> | void) | undefined;
};

class CatalogAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogAssetError";
  }
}

function wait(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function ensureManagedDirectory(
  state: AssetRootState,
  directoryPath: string,
  options?: { create?: boolean; label?: string },
) {
  assertContainedPath(state.absoluteRoot, directoryPath, options?.label ?? "asset path");

  if (options?.create ?? true) {
    await mkdir(directoryPath, { recursive: true });
  }

  const realDirectoryPath = await realpath(directoryPath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await assertExistingAncestorInsideRoot(
      state,
      dirname(directoryPath),
      options?.label ?? "asset path",
    );
    throw error;
  });
  assertInsideRealRoot(state.realRoot, realDirectoryPath, options?.label ?? "asset path");
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

async function assertRegularFileAtPath(absolutePath: string, label: string) {
  const fileStats = await lstat(absolutePath);
  if (fileStats.isSymbolicLink()) {
    throw new CatalogAssetError(`${label} resolves outside CATALOG_ASSET_DIR`);
  }
  if (!fileStats.isFile()) {
    throw new CatalogAssetError(`${label} is not a file`);
  }
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

async function sumDirectoryBytes(directoryPath: string): Promise<number> {
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
    const absolutePath = join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CatalogAssetError("asset path resolves outside CATALOG_ASSET_DIR");
    }
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

async function writeExclusiveFile(path: string, bytes: Uint8Array) {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, WRITE_NOFOLLOW_FLAGS, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await safeClose(handle);
    throw error;
  }
  await safeClose(handle);
}

async function openManagedFile(
  state: AssetRootState,
  relativeKey: string,
  label: string,
): Promise<ManagedFile> {
  const absolutePath = await resolveManagedFilePath(state, relativeKey, label, {
    createParent: false,
  });
  await assertRegularFileAtPath(absolutePath, label);

  let handle: FileHandle | null = null;
  try {
    handle = await open(absolutePath, READ_NOFOLLOW_FLAGS);
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) {
      throw new CatalogAssetError(`${label} is not a file`);
    }
    return { handle, path: absolutePath };
  } catch (error) {
    await safeClose(handle);
    throw error;
  }
}

async function readManagedFile(
  state: AssetRootState,
  relativeKey: string,
  label: string,
): Promise<Uint8Array> {
  const managedFile = await openManagedFile(state, relativeKey, label);
  try {
    const bytes = await managedFile.handle.readFile();
    return new Uint8Array(bytes);
  } finally {
    await safeClose(managedFile.handle);
  }
}

async function publishBytesAtomically(
  state: AssetRootState,
  options: PublishBytesOptions,
): Promise<PublishBytesResult> {
  const finalDirectory = dirname(options.targetPath);
  await ensureManagedDirectory(state, finalDirectory, {
    create: true,
    label: "storage key",
  });

  const tempName = `.catalog-asset-${crypto.randomUUID()}.tmp`;
  const tempPath = join(finalDirectory, tempName);
  assertContainedPath(state.absoluteRoot, tempPath, "storage key");

  try {
    await writeExclusiveFile(tempPath, options.bytes);
    await options.onReady?.();

    try {
      await link(tempPath, options.targetPath);
      return { published: true };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        throw error;
      }

      if (options.expectedDigest && options.expectedMimeType) {
        const existingKey = relative(state.absoluteRoot, options.targetPath).replaceAll("\\", "/");
        const existingBytes = await readManagedFile(state, existingKey, "storage key");
        const existingValidation = await validateImageBytes(
          existingBytes,
          {
            maxFileBytes: DEFAULT_MAX_FILE_BYTES,
            maxPixelCount: DEFAULT_MAX_PIXEL_COUNT,
          },
          options.expectedMimeType,
        );
        if (existingValidation.contentSha256 !== options.expectedDigest) {
          throw new CatalogAssetError("stored catalog asset digest does not match the storage key");
        }
      }

      return { published: false };
    }
  } finally {
    await safeUnlink(tempPath);
  }
}

async function withRunLock<T>(
  state: AssetRootState,
  dependencies: StorageDependencies,
  runId: string,
  action: () => Promise<T>,
) {
  const lockParent = resolve(state.absoluteRoot, ".locks", "runs");
  const lockPath = join(lockParent, `${runId}.lock`);
  const leasePath = join(lockPath, "lease.json");
  const startedAt = Date.now();

  await ensureManagedDirectory(state, lockParent, { create: true, label: "lock path" });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        leasePath,
        JSON.stringify({
          createdAt: new Date().toISOString(),
          pid: process.pid,
          runId,
        }),
      );
      break;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        throw error;
      }

      const lockStats = await lstat(lockPath).catch((lockError: NodeJS.ErrnoException) => {
        if (lockError.code === "ENOENT") {
          return null;
        }
        throw lockError;
      });
      if (!lockStats) {
        continue;
      }
      if (lockStats.isSymbolicLink()) {
        throw new CatalogAssetError("lock path resolves outside CATALOG_ASSET_DIR");
      }

      if (Date.now() - lockStats.mtimeMs > dependencies.lockStaleMs) {
        await rm(lockPath, { force: true, recursive: true }).catch((staleError: NodeJS.ErrnoException) => {
          if (staleError.code !== "ENOENT") {
            throw staleError;
          }
        });
        continue;
      }

      if (Date.now() - startedAt > dependencies.lockTimeoutMs) {
        throw new CatalogAssetError("timed out waiting for the catalog asset run lock");
      }

      await wait(dependencies.lockRetryDelayMs);
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true, recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export function createCatalogAssetStorage(options: CatalogAssetStorageOptions = {}) {
  const dependencies: StorageDependencies = {
    assetDir: options.assetDir?.trim() || process.env.CATALOG_ASSET_DIR?.trim() || DEFAULT_CATALOG_ASSET_DIR,
    lockRetryDelayMs: options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
    lockStaleMs: options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxPixelCount: options.maxPixelCount ?? DEFAULT_MAX_PIXEL_COUNT,
    maxRunBytes: options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES,
    onFinalPublishReady: options.onFinalPublishReady,
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

    await withRunLock(state, dependencies, input.runId, async () => {
      try {
        const existingBytes = await readManagedFile(state, temporaryKey, "temporary asset path");
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

      const currentRunBytes = await sumDirectoryBytes(runDirectoryPath);
      if (currentRunBytes + input.bytes.byteLength > dependencies.maxRunBytes) {
        throw new CatalogAssetError("catalog migration assets must stay within the 1 GiB per-run limit");
      }

      await publishBytesAtomically(state, {
        bytes: input.bytes,
        targetPath: temporaryPath,
      });
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
    const stagedBytes = await readManagedFile(state, manifest.temporaryKey, "temporary asset path");
    if (stagedBytes.byteLength !== manifest.byteSize) {
      throw new CatalogAssetError("temporary asset size does not match the manifest");
    }

    const validation = await validateImageBytes(stagedBytes, dependencies, manifest.mimeType);
    if (validation.contentSha256 !== manifest.contentSha256) {
      throw new CatalogAssetError("temporary asset digest does not match the manifest");
    }

    const storageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.${expectedExtension}`;
    const finalPath = await resolveManagedFilePath(state, storageKey, "storage key");

    await publishBytesAtomically(state, {
      bytes: stagedBytes,
      expectedDigest: manifest.contentSha256,
      expectedMimeType: manifest.mimeType,
      onReady: dependencies.onFinalPublishReady,
      targetPath: finalPath,
    });
    await safeUnlink(resolve(state.absoluteRoot, manifest.temporaryKey));

    return storageKey;
  }

  async function discardStagedAssets(runId: string): Promise<void> {
    assertRunId(runId);

    const state = await getAssetRootState(dependencies.assetDir);
    const runDirectoryPath = resolve(state.absoluteRoot, "temporary", runId);
    assertContainedPath(state.absoluteRoot, runDirectoryPath, "run directory");

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

    await rm(runDirectoryPath, { force: true, recursive: true });
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
