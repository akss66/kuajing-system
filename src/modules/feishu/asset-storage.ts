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
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import sharp from "sharp";

import type { TemporaryAssetManifest } from "./cargo-types";

const DEFAULT_CATALOG_ASSET_DIR = "/app/data/catalog-assets";
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PIXEL_COUNT = 25_000_000;
const DEFAULT_MAX_RUN_BYTES = 1024 * 1024 * 1024;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
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
type LeaseKind = "claim" | "run";
type AssetRootState = {
  absoluteRoot: string;
  realRoot: string;
};
type RunLockControl = {
  assertHeld(): void;
  ownerToken: string;
  stopHeartbeat(): void;
};
type ClaimLeaseControl = RunLockControl & {
  targetPath: string;
};
type LeaseWriteContext = {
  kind: LeaseKind;
  ownerToken: string;
  path: string;
};
type ClaimAcquiredContext = {
  ownerToken: string;
  targetPath: string;
};
type TargetWriteProgress = {
  bytesWritten: number;
  targetPath: string;
  totalBytes: number;
};
type CatalogAssetStorageOptions = {
  assetDir?: string;
  claimHeartbeatIntervalMs?: number;
  claimStaleMs?: number;
  heartbeatIntervalMs?: number;
  lockRetryDelayMs?: number;
  lockStaleMs?: number;
  lockTimeoutMs?: number;
  maxFileBytes?: number;
  maxPixelCount?: number;
  maxRunBytes?: number;
  onClaimAcquired?: ((context: ClaimAcquiredContext) => Promise<void> | void) | undefined;
  onClaimLeaseAcquired?: ((control: ClaimLeaseControl) => Promise<void> | void) | undefined;
  onDirectorySync?: ((path: string, reason: DirectorySyncReason) => Promise<void> | void) | undefined;
  onFinalPublishReady?: (() => Promise<void> | void) | undefined;
  onLeaseWrite?: ((context: LeaseWriteContext) => Promise<void> | void) | undefined;
  onRunLockAcquired?: ((control: RunLockControl) => Promise<void> | void) | undefined;
  onStageWriteReady?: (() => Promise<void> | void) | undefined;
  onStorageLink?: ((temporaryPath: string, targetPath: string) => Promise<void> | void) | undefined;
  onTargetWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
  targetWriteChunkSize?: number;
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
type LockLeasePayload = {
  heartbeatAt: string;
  ownerToken: string;
  pid: number;
  runId: string;
};
type LockLease = LockLeasePayload & {
  heartbeatAtMs: number;
};
type HeartbeatController = {
  assertHeld(): void;
  awaitStopped(): Promise<void>;
  stop(): void;
};
type StorageDependencies = Required<
  Pick<
    CatalogAssetStorageOptions,
    | "assetDir"
    | "claimHeartbeatIntervalMs"
    | "claimStaleMs"
    | "heartbeatIntervalMs"
    | "lockRetryDelayMs"
    | "lockStaleMs"
    | "lockTimeoutMs"
    | "maxFileBytes"
    | "maxPixelCount"
    | "maxRunBytes"
    | "targetWriteChunkSize"
  >
> & {
  onClaimAcquired?: ((context: ClaimAcquiredContext) => Promise<void> | void) | undefined;
  onClaimLeaseAcquired?: ((control: ClaimLeaseControl) => Promise<void> | void) | undefined;
  onDirectorySync?: ((path: string, reason: DirectorySyncReason) => Promise<void> | void) | undefined;
  onFinalPublishReady?: (() => Promise<void> | void) | undefined;
  onLeaseWrite?: ((context: LeaseWriteContext) => Promise<void> | void) | undefined;
  onRunLockAcquired?: ((control: RunLockControl) => Promise<void> | void) | undefined;
  onStageWriteReady?: (() => Promise<void> | void) | undefined;
  onStorageLink?: ((temporaryPath: string, targetPath: string) => Promise<void> | void) | undefined;
  onTargetWriteProgress?: ((progress: TargetWriteProgress) => Promise<void> | void) | undefined;
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

class CatalogAssetLeaseLostError extends CatalogAssetError {
  constructor(message: string) {
    super(message);
    this.name = "CatalogAssetLeaseLostError";
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

function serializeLease(payload: LockLeasePayload) {
  return JSON.stringify(payload);
}

function parseLease(bytes: Uint8Array): LockLease | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<LockLeasePayload>;
    if (
      typeof parsed.heartbeatAt !== "string" ||
      typeof parsed.ownerToken !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.runId !== "string"
    ) {
      return null;
    }
    const heartbeatAtMs = Date.parse(parsed.heartbeatAt);
    if (!Number.isFinite(heartbeatAtMs)) {
      return null;
    }
    return {
      heartbeatAt: parsed.heartbeatAt,
      heartbeatAtMs,
      ownerToken: parsed.ownerToken,
      pid: parsed.pid,
      runId: parsed.runId,
    };
  } catch {
    return null;
  }
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

async function syncDirectory(
  directoryPath: string,
  dependencies: StorageDependencies,
  reason: DirectorySyncReason,
) {
  await dependencies.onDirectorySync?.(directoryPath, reason);

  let handle: FileHandle | null = null;
  try {
    handle = await open(directoryPath, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (
      process.platform !== "linux" &&
      (nodeError.code === "EINVAL" ||
        nodeError.code === "ENOTSUP" ||
        nodeError.code === "EPERM" ||
        nodeError.code === "EISDIR")
    ) {
      return;
    }
    throw error;
  } finally {
    await safeClose(handle);
  }
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
    return new Uint8Array(await managedFile.handle.readFile());
  } finally {
    await safeClose(managedFile.handle);
  }
}

async function readLockLeaseFromPath(leasePath: string): Promise<LockLease | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(leasePath, READ_NOFOLLOW_FLAGS);
    return parseLease(new Uint8Array(await handle.readFile()));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  } finally {
    await safeClose(handle);
  }
}

async function verifyExistingPublishedTarget(
  state: AssetRootState,
  dependencies: StorageDependencies,
  options: Pick<PublishBytesOptions, "expectedDigest" | "expectedMimeType" | "targetPath">,
) {
  const existingKey = relative(state.absoluteRoot, options.targetPath).replaceAll("\\", "/");
  const existingBytes = await readManagedFile(state, existingKey, "storage key");
  if (options.expectedDigest && options.expectedMimeType) {
    const validation = await validateImageBytes(existingBytes, dependencies, options.expectedMimeType);
    if (validation.contentSha256 !== options.expectedDigest) {
      throw new CatalogAssetConflictError("existing catalog asset conflicts with the requested digest");
    }
  }
}

async function renameWithinRoot(
  state: AssetRootState,
  sourcePath: string,
  targetPath: string,
  label: string,
) {
  assertContainedPath(state.absoluteRoot, targetPath, label);
  await ensureManagedDirectory(state, dirname(targetPath), { create: true, label });

  try {
    await rename(sourcePath, targetPath);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function fallbackPublishByClaim(
  state: AssetRootState,
  dependencies: StorageDependencies,
  options: PublishBytesOptions,
): Promise<PublishBytesResult> {
  const finalDirectory = dirname(options.targetPath);
  const claimPath = `${options.targetPath}.claim`;

  const publishResult = await withLeasedDirectory(
    state,
    dependencies,
    {
      heartbeatIntervalMs: dependencies.claimHeartbeatIntervalMs,
      kind: "claim",
      lockPath: claimPath,
      onAcquired: async (control) => {
        await dependencies.onClaimLeaseAcquired?.({
          ...control,
          targetPath: options.targetPath,
        });
      },
      resourceId: options.targetPath,
      staleMs: dependencies.claimStaleMs,
    },
    async (claimControl) => {
      await dependencies.onClaimAcquired?.({
        ownerToken: claimControl.ownerToken,
        targetPath: options.targetPath,
      });
      claimControl.assertHeld();

      try {
        await verifyExistingPublishedTarget(state, dependencies, options);
        return { published: false } satisfies PublishBytesResult;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "ENOENT") {
          throw error;
        }
      }

      claimControl.assertHeld();

      let targetHandle: FileHandle | null = null;
      let targetCreated = false;
      try {
        targetHandle = await open(options.targetPath, WRITE_NOFOLLOW_FLAGS, 0o600);
        targetCreated = true;

        let bytesWritten = 0;
        const chunkSize = Math.max(1, dependencies.targetWriteChunkSize);
        while (bytesWritten < options.bytes.byteLength) {
          claimControl.assertHeld();

          const nextBytesWritten = Math.min(bytesWritten + chunkSize, options.bytes.byteLength);
          const chunk = Buffer.from(options.bytes.subarray(bytesWritten, nextBytesWritten));
          await targetHandle.write(chunk, 0, chunk.byteLength, bytesWritten);
          bytesWritten = nextBytesWritten;

          await dependencies.onTargetWriteProgress?.({
            bytesWritten,
            targetPath: options.targetPath,
            totalBytes: options.bytes.byteLength,
          });
          claimControl.assertHeld();
        }

        await targetHandle.sync();
        await safeClose(targetHandle);
        targetHandle = null;
        await syncDirectory(finalDirectory, dependencies, "publish");
        return { published: true } satisfies PublishBytesResult;
      } catch (error) {
        await safeClose(targetHandle);
        const nodeError = error as NodeJS.ErrnoException;
        if (!targetCreated && nodeError.code === "EEXIST") {
          await verifyExistingPublishedTarget(state, dependencies, options);
          return { published: false } satisfies PublishBytesResult;
        }

        if (targetCreated) {
          await safeUnlink(options.targetPath);
          await syncDirectory(finalDirectory, dependencies, "cleanup");
        }
        throw error;
      }
    },
  );

  await syncDirectory(finalDirectory, dependencies, "cleanup");
  return publishResult;
}

async function publishBytesAtomically(
  state: AssetRootState,
  dependencies: StorageDependencies,
  options: PublishBytesOptions,
): Promise<PublishBytesResult> {
  const isFinalPublish = Boolean(options.expectedDigest && options.expectedMimeType);
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
      if (isFinalPublish && dependencies.onStorageLink) {
        await dependencies.onStorageLink(tempPath, options.targetPath);
      } else {
        if (isFinalPublish) {
          await link(tempPath, options.targetPath);
        } else {
          const moved = await renameWithinRoot(state, tempPath, options.targetPath, "temporary asset path");
          if (!moved) {
            throw new CatalogAssetError("temporary asset publish source disappeared before rename");
          }
        }
      }
      await syncDirectory(finalDirectory, dependencies, "publish");
      return { published: true };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (isFinalPublish && HARD_LINK_UNSUPPORTED_CODES.has(nodeError.code ?? "")) {
        return await fallbackPublishByClaim(state, dependencies, options);
      }
      if (nodeError.code !== "EEXIST") {
        throw error;
      }

      if (isFinalPublish) {
        await verifyExistingPublishedTarget(state, dependencies, options);
      }
      return { published: false };
    }
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
      await syncDirectory(finalDirectory, dependencies, "cleanup");
    }
  }
}

async function writeLockLease(
  leasePath: string,
  ownerToken: string,
  runId: string,
  kind: LeaseKind,
  dependencies: StorageDependencies,
) {
  const currentLease = await readLockLeaseFromPath(leasePath);
  if (currentLease && currentLease.ownerToken !== ownerToken) {
    throw new CatalogAssetLeaseLostError(`${kind} lease owner token no longer matches the current lease`);
  }

  const tempLeasePath = `${leasePath}.${ownerToken}.next`;
  try {
    await dependencies.onLeaseWrite?.({
      kind,
      ownerToken,
      path: leasePath,
    });
    await writeExclusiveFile(
      tempLeasePath,
      Buffer.from(
        serializeLease({
          heartbeatAt: new Date().toISOString(),
          ownerToken,
          pid: process.pid,
          runId,
        }),
        "utf8",
      ),
    );
    await rename(tempLeasePath, leasePath);
  } finally {
    await safeUnlink(tempLeasePath);
  }
}

function startLockHeartbeat(
  leasePath: string,
  dependencies: StorageDependencies,
  ownerToken: string,
  runId: string,
  kind: LeaseKind,
  heartbeatIntervalMs: number,
): HeartbeatController {
  let stopped = false;
  let lostError: Error | null = null;
  let timer: NodeJS.Timeout | null = null;
  let resolveStopped: (() => void) | null = null;
  let tickInFlight = 0;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const maybeResolveStopped = () => {
    if (!stopped || tickInFlight > 0) {
      return;
    }
    resolveStopped?.();
  };

  const finish = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    maybeResolveStopped();
  };

  const tick = async () => {
    if (stopped) {
      return;
    }

    tickInFlight += 1;
    try {
      await writeLockLease(leasePath, ownerToken, runId, kind, dependencies);
    } catch (error) {
      lostError =
        error instanceof Error
          ? error
          : new CatalogAssetLeaseLostError(`lost the ${kind} lease while renewing the heartbeat`);
      tickInFlight -= 1;
      finish();
      return;
    }
    tickInFlight -= 1;

    if (stopped) {
      maybeResolveStopped();
      return;
    }

    timer = setTimeout(() => {
      void tick();
    }, heartbeatIntervalMs);
    timer.unref?.();
  };

  timer = setTimeout(() => {
    void tick();
  }, heartbeatIntervalMs);
  timer.unref?.();

  return {
    assertHeld() {
      if (lostError) {
        throw lostError;
      }
    },
    async awaitStopped() {
      await stoppedPromise;
    },
    stop() {
      finish();
    },
  };
}

async function tryReclaimStaleLock(
  state: AssetRootState,
  lockPath: string,
  leasePath: string,
  staleMs: number,
) {
  const lockStats = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!lockStats) {
    return true;
  }
  if (lockStats.isSymbolicLink()) {
    throw new CatalogAssetError("lock path resolves outside CATALOG_ASSET_DIR");
  }

  const lease = await readLockLeaseFromPath(leasePath);
  const lastHeartbeatAtMs = lease?.heartbeatAtMs ?? lockStats.mtimeMs;
  if (Date.now() - lastHeartbeatAtMs <= staleMs) {
    return false;
  }

  const reclaimedPath = join(
    dirname(lockPath),
    `${basename(lockPath)}.stale-${crypto.randomUUID()}`,
  );
  const moved = await renameWithinRoot(state, lockPath, reclaimedPath, "lock path");
  if (!moved) {
    return true;
  }

  await rm(reclaimedPath, { force: true, recursive: true });
  return true;
}

async function releaseRunLock(
  state: AssetRootState,
  lockPath: string,
  ownerToken: string,
) {
  const leasePath = join(lockPath, "lease.json");
  const lease = await readLockLeaseFromPath(leasePath);
  if (!lease || lease.ownerToken !== ownerToken) {
    return;
  }

  const releasedPath = join(
    dirname(lockPath),
    `${basename(lockPath)}.release-${ownerToken}-${crypto.randomUUID()}`,
  );
  const moved = await renameWithinRoot(state, lockPath, releasedPath, "lock path");
  if (!moved) {
    return;
  }

  await rm(releasedPath, { force: true, recursive: true });
}

async function withLeasedDirectory<T>(
  state: AssetRootState,
  dependencies: StorageDependencies,
  input: {
    heartbeatIntervalMs: number;
    kind: LeaseKind;
    lockPath: string;
    onAcquired?: ((control: RunLockControl) => Promise<void> | void) | undefined;
    resourceId: string;
    staleMs: number;
  },
  action: (control: RunLockControl) => Promise<T>,
) {
  const lockParent = dirname(input.lockPath);
  const lockPath = input.lockPath;
  const leasePath = join(lockPath, "lease.json");
  const startedAt = Date.now();

  await ensureManagedDirectory(state, lockParent, {
    create: true,
    label: input.kind === "run" ? "lock path" : "claim path",
  });

  while (true) {
    const ownerToken = crypto.randomUUID();
    try {
      await mkdir(lockPath);
      await ensureManagedDirectory(state, lockPath, {
        create: false,
        label: input.kind === "run" ? "lock path" : "claim path",
      });

      try {
        await writeExclusiveFile(
          leasePath,
          Buffer.from(
            serializeLease({
              heartbeatAt: new Date().toISOString(),
              ownerToken,
              pid: process.pid,
              runId: input.resourceId,
            }),
            "utf8",
          ),
        );
        const heartbeat = startLockHeartbeat(
          leasePath,
          dependencies,
          ownerToken,
          input.resourceId,
          input.kind,
          input.heartbeatIntervalMs,
        );
        const control: RunLockControl = {
          assertHeld() {
            heartbeat.assertHeld();
          },
          ownerToken,
          stopHeartbeat() {
            heartbeat.stop();
          },
        };
        await input.onAcquired?.(control);
        control.assertHeld();

        try {
          return await action(control);
        } finally {
          heartbeat.stop();
          await heartbeat.awaitStopped();
          await releaseRunLock(state, lockPath, ownerToken);
        }
      } catch (error) {
        await releaseRunLock(state, lockPath, ownerToken);
        throw error;
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") {
        throw error;
      }

      const reclaimed = await tryReclaimStaleLock(state, lockPath, leasePath, input.staleMs);
      if (reclaimed) {
        continue;
      }

      if (Date.now() - startedAt > dependencies.lockTimeoutMs) {
        throw new CatalogAssetError("timed out waiting for the catalog asset run lock");
      }

      await wait(dependencies.lockRetryDelayMs);
    }
  }
}

async function withRunLock<T>(
  state: AssetRootState,
  dependencies: StorageDependencies,
  runId: string,
  action: (control: RunLockControl) => Promise<T>,
) {
  return await withLeasedDirectory(
    state,
    dependencies,
    {
      heartbeatIntervalMs: dependencies.heartbeatIntervalMs,
      kind: "run",
      lockPath: join(resolve(state.absoluteRoot, ".locks", "runs"), `${runId}.lock`),
      onAcquired: dependencies.onRunLockAcquired,
      resourceId: runId,
      staleMs: dependencies.lockStaleMs,
    },
    action,
  );
}

export function createCatalogAssetStorage(options: CatalogAssetStorageOptions = {}) {
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    Math.min(DEFAULT_HEARTBEAT_INTERVAL_MS, Math.max(10, Math.floor(lockStaleMs / 3)));
  if (heartbeatIntervalMs >= lockStaleMs) {
    throw new CatalogAssetError("heartbeat interval must be smaller than the run lock stale timeout");
  }
  const claimStaleMs = options.claimStaleMs ?? lockStaleMs;
  const claimHeartbeatIntervalMs =
    options.claimHeartbeatIntervalMs ??
    Math.min(DEFAULT_HEARTBEAT_INTERVAL_MS, Math.max(10, Math.floor(claimStaleMs / 3)));
  if (claimHeartbeatIntervalMs >= claimStaleMs) {
    throw new CatalogAssetError("heartbeat interval must be smaller than the claim stale timeout");
  }

  const dependencies: StorageDependencies = {
    assetDir: options.assetDir?.trim() || process.env.CATALOG_ASSET_DIR?.trim() || DEFAULT_CATALOG_ASSET_DIR,
    claimHeartbeatIntervalMs,
    claimStaleMs,
    heartbeatIntervalMs,
    lockRetryDelayMs: options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
    lockStaleMs,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxPixelCount: options.maxPixelCount ?? DEFAULT_MAX_PIXEL_COUNT,
    maxRunBytes: options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES,
    onClaimAcquired: options.onClaimAcquired,
    onClaimLeaseAcquired: options.onClaimLeaseAcquired,
    onDirectorySync: options.onDirectorySync,
    onFinalPublishReady: options.onFinalPublishReady,
    onLeaseWrite: options.onLeaseWrite,
    onRunLockAcquired: options.onRunLockAcquired,
    onStageWriteReady: options.onStageWriteReady,
    onStorageLink: options.onStorageLink,
    onTargetWriteProgress: options.onTargetWriteProgress,
    targetWriteChunkSize: options.targetWriteChunkSize ?? 64 * 1024,
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

    await withRunLock(state, dependencies, input.runId, async (runLock) => {
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

      runLock.assertHeld();
      const currentRunBytes = await sumDirectoryBytes(runDirectoryPath);
      if (currentRunBytes + input.bytes.byteLength > dependencies.maxRunBytes) {
        throw new CatalogAssetError("catalog migration assets must stay within the 1 GiB per-run limit");
      }

      await dependencies.onStageWriteReady?.();
      runLock.assertHeld();

      await publishBytesAtomically(state, dependencies, {
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

    await publishBytesAtomically(state, dependencies, {
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
