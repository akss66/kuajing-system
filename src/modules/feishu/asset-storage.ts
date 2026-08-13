import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
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
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PIXEL_COUNT = 25_000_000;
const MAX_RUN_BYTES = 1024 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TEMPORARY_KEY_PATTERN =
  /^temporary\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([0-9a-f]{64})\.(jpg|png|webp)$/;
const STORAGE_KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.(jpg|png|webp)$/;

type ImageMimeType = TemporaryAssetManifest["mimeType"];
type ImageExtension = "jpg" | "png" | "webp";
type AssetRootState = {
  absoluteRoot: string;
  realRoot: string;
};

class CatalogAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogAssetError";
  }
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

async function getAssetRootState(): Promise<AssetRootState> {
  const configuredRoot = process.env.CATALOG_ASSET_DIR?.trim() || DEFAULT_CATALOG_ASSET_DIR;
  const absoluteRoot = resolve(configuredRoot);
  await mkdir(absoluteRoot, { recursive: true });
  return {
    absoluteRoot,
    realRoot: await realpath(absoluteRoot),
  };
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

async function ensureDirectoryInsideRoot(state: AssetRootState, directoryPath: string) {
  await mkdir(directoryPath, { recursive: true });
  const realDirectoryPath = await realpath(directoryPath);
  const comparableRoot = toComparablePath(state.realRoot);
  const comparableDirectory = toComparablePath(realDirectoryPath);
  if (
    comparableDirectory !== comparableRoot &&
    !comparableDirectory.startsWith(`${comparableRoot}\\`) &&
    !comparableDirectory.startsWith(`${comparableRoot}/`)
  ) {
    throw new CatalogAssetError("asset path resolves outside CATALOG_ASSET_DIR");
  }
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

async function assertRegularFileInsideRoot(state: AssetRootState, absolutePath: string) {
  const fileStats = await lstat(absolutePath);
  if (fileStats.isSymbolicLink()) {
    throw new CatalogAssetError("asset path resolves outside CATALOG_ASSET_DIR");
  }
  if (!fileStats.isFile()) {
    throw new CatalogAssetError("asset path is not a file");
  }

  const realFilePath = await realpath(absolutePath);
  const comparableRoot = toComparablePath(state.realRoot);
  const comparableFile = toComparablePath(realFilePath);
  if (
    comparableFile !== comparableRoot &&
    !comparableFile.startsWith(`${comparableRoot}\\`) &&
    !comparableFile.startsWith(`${comparableRoot}/`)
  ) {
    throw new CatalogAssetError("asset path resolves outside CATALOG_ASSET_DIR");
  }
}

async function resolveManagedFilePath(
  state: AssetRootState,
  relativeKey: string,
  label: string,
): Promise<string> {
  const absolutePath = resolve(state.absoluteRoot, relativeKey);
  assertContainedPath(state.absoluteRoot, absolutePath, label);
  await ensureDirectoryInsideRoot(state, dirname(absolutePath));
  return absolutePath;
}

async function safeUnlink(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function validateImageBytes(
  bytes: Uint8Array,
  expectedMimeType?: ImageMimeType,
): Promise<{ contentSha256: string; extension: ImageExtension; mimeType: ImageMimeType }> {
  if (bytes.byteLength > MAX_FILE_BYTES) {
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

  if (metadata.width * metadata.height > MAX_PIXEL_COUNT) {
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
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );

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

async function publishBytes(state: AssetRootState, targetPath: string, bytes: Uint8Array) {
  try {
    await assertRegularFileInsideRoot(state, targetPath);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !/ENOENT/.test(String(error))) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  let handle;
  try {
    handle = await open(targetPath, "wx");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EEXIST") {
      await assertRegularFileInsideRoot(state, targetPath);
      return;
    }
    throw error;
  }

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await safeUnlink(targetPath);
    throw error;
  }

  await handle.close();
}

async function promoteTemporaryAsset(state: AssetRootState, temporaryPath: string, finalPath: string) {
  try {
    await assertRegularFileInsideRoot(state, finalPath);
    await safeUnlink(temporaryPath);
    return;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await writeFile(finalPath, await readFile(temporaryPath), { flag: "wx" });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EEXIST") {
      await assertRegularFileInsideRoot(state, finalPath);
      await safeUnlink(temporaryPath);
      return;
    }
    await safeUnlink(finalPath);
    throw error;
  }

  await safeUnlink(temporaryPath);
}

export async function stageCatalogAsset(input: {
  bytes: Uint8Array;
  contentType: string;
  originalFileName: string;
  runId: string;
  skuCode: string;
}): Promise<TemporaryAssetManifest> {
  assertRunId(input.runId);

  const validation = await validateImageBytes(input.bytes, input.contentType as ImageMimeType);
  const temporaryKey = `temporary/${input.runId}/${validation.contentSha256}.${validation.extension}`;
  const state = await getAssetRootState();
  const temporaryPath = await resolveManagedFilePath(state, temporaryKey, "temporary asset path");
  const runDirectoryPath = resolve(state.absoluteRoot, `temporary/${input.runId}`);
  assertContainedPath(state.absoluteRoot, runDirectoryPath, "run directory");
  await ensureDirectoryInsideRoot(state, runDirectoryPath);

  try {
    await assertRegularFileInsideRoot(state, temporaryPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }

    const currentRunBytes = await sumDirectoryBytes(runDirectoryPath);
    if (currentRunBytes + input.bytes.byteLength > MAX_RUN_BYTES) {
      throw new CatalogAssetError("catalog migration assets must stay within the 1 GiB per-run limit");
    }

    await publishBytes(state, temporaryPath, input.bytes);
  }

  return {
    byteSize: input.bytes.byteLength,
    contentSha256: validation.contentSha256,
    mimeType: validation.mimeType,
    originalFileName: input.originalFileName,
    skuCode: input.skuCode,
    temporaryKey,
  };
}

export async function commitCatalogAsset(manifest: TemporaryAssetManifest): Promise<string> {
  if (!DIGEST_PATTERN.test(manifest.contentSha256)) {
    throw new CatalogAssetError("content sha256 is invalid");
  }

  const temporary = assertValidTemporaryKey(manifest.temporaryKey);
  const expectedExtension = extensionForMimeType(manifest.mimeType);
  if (temporary.contentSha256 !== manifest.contentSha256 || temporary.extension !== expectedExtension) {
    throw new CatalogAssetError("temporary manifest does not match the content digest or mime type");
  }

  const state = await getAssetRootState();
  const temporaryPath = await resolveManagedFilePath(state, manifest.temporaryKey, "temporary asset path");
  await assertRegularFileInsideRoot(state, temporaryPath);

  const bytes = await readFile(temporaryPath);
  if (bytes.byteLength !== manifest.byteSize) {
    throw new CatalogAssetError("temporary asset size does not match the manifest");
  }

  const validation = await validateImageBytes(bytes, manifest.mimeType);
  if (validation.contentSha256 !== manifest.contentSha256) {
    throw new CatalogAssetError("temporary asset digest does not match the manifest");
  }

  const storageKey = `sha256/${manifest.contentSha256.slice(0, 2)}/${manifest.contentSha256}.${expectedExtension}`;
  const finalPath = await resolveManagedFilePath(state, storageKey, "storage key");
  await promoteTemporaryAsset(state, temporaryPath, finalPath);
  return storageKey;
}

export async function discardStagedAssets(runId: string): Promise<void> {
  assertRunId(runId);

  const state = await getAssetRootState();
  const runDirectoryPath = resolve(state.absoluteRoot, `temporary/${runId}`);
  assertContainedPath(state.absoluteRoot, runDirectoryPath, "run directory");

  try {
    await ensureDirectoryInsideRoot(state, runDirectoryPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
  }

  await rm(runDirectoryPath, { force: true, recursive: true });
}

export async function openCatalogAsset(
  storageKey: string,
): Promise<{ bytes: Uint8Array; contentType: ImageMimeType }> {
  const parsed = assertValidStorageKey(storageKey);
  const state = await getAssetRootState();
  const absolutePath = await resolveManagedFilePath(state, storageKey, "storage key");
  await assertRegularFileInsideRoot(state, absolutePath);

  const bytes = await readFile(absolutePath);
  const validation = await validateImageBytes(bytes, mimeTypeForExtension(parsed.extension));
  if (validation.contentSha256 !== parsed.contentSha256) {
    throw new CatalogAssetError("stored catalog asset digest does not match the storage key");
  }

  return {
    bytes,
    contentType: validation.mimeType,
  };
}
