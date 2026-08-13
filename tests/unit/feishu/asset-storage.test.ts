import { spawn } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
