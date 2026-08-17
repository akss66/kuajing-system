import { randomUUID } from "node:crypto";

import { createCatalogAssetStorage } from "@/modules/feishu/asset-storage";

import type { ManagedCatalogImageAsset } from "./sku-management-service";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class CatalogImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogImageUploadError";
  }
}

export async function storeCatalogImageUpload(input: {
  file: File;
  skuCode: string;
}): Promise<ManagedCatalogImageAsset> {
  if (input.file.size <= 0) {
    throw new CatalogImageUploadError("请选择有效的商品图片");
  }
  if (input.file.size > MAX_UPLOAD_BYTES) {
    throw new CatalogImageUploadError("商品图片不能超过 8 MiB");
  }
  if (!ALLOWED_IMAGE_TYPES.has(input.file.type)) {
    throw new CatalogImageUploadError("商品图片仅支持 JPEG、PNG 或 WebP");
  }

  const runId = randomUUID();
  const storage = createCatalogAssetStorage();
  try {
    const manifest = await storage.stageCatalogAsset({
      bytes: new Uint8Array(await input.file.arrayBuffer()),
      contentType: input.file.type,
      originalFileName: input.file.name || `${input.skuCode}.bin`,
      runId,
      skuCode: input.skuCode,
    });
    const storageKey = await storage.commitCatalogAsset(manifest);
    return {
      byteSize: manifest.byteSize,
      contentSha256: manifest.contentSha256,
      mimeType: manifest.mimeType,
      originalFileName: manifest.originalFileName,
      storageKey,
    };
  } catch (error) {
    if (error instanceof CatalogImageUploadError) throw error;
    throw new CatalogImageUploadError("商品图片校验或保存失败，请检查图片后重试");
  } finally {
    await storage.discardStagedAssets(runId).catch(() => undefined);
  }
}
