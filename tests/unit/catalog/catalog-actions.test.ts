import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const guardMocks = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
const uploadMocks = vi.hoisted(() => ({ storeCatalogImageUpload: vi.fn() }));
const serviceMocks = vi.hoisted(() => ({
  batchManageSkus: vi.fn(),
  createManagedSku: vi.fn(),
  deleteManagedSku: vi.fn(),
  restoreManagedSku: vi.fn(),
  updateManagedProduct: vi.fn(),
  updateManagedSku: vi.fn(),
}));

vi.mock("next/cache", () => cacheMocks);
vi.mock("@/modules/identity/guards", () => guardMocks);
vi.mock("@/modules/catalog/catalog-image-upload", () => uploadMocks);
vi.mock("@/modules/catalog/sku-management-service", () => ({
  CatalogManagementError: class CatalogManagementError extends Error {},
  ...serviceMocks,
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/modules/order-import/service", () => ({
  refreshActiveImportPreviewsForAlias: vi.fn(),
}));

import { createSkuAction, updateSkuAction } from "@/modules/catalog/actions";

function createSkuForm(image?: File) {
  const formData = new FormData();
  formData.set("productMode", "CREATE");
  formData.set("sourceSequence", "77");
  formData.set("productName", "新商品");
  formData.set("cargoPriceYuan", "8.00");
  formData.set("linkText", "新商品链接");
  formData.set("skuCode", "TZX-077-1");
  formData.set("defaultPriceYuan", "3.10");
  formData.set("initialStock", "9");
  formData.set("productUrl", "https://example.test/new-product");
  formData.set("specification", "20*10cm");
  formData.set("color", "蓝色");
  formData.set("combination", "单件");
  formData.set("weightGrams", "68");
  formData.set("saleStatus", "SELLABLE");
  formData.set("reason", "录入新商品");
  if (image) formData.set("image", image);
  return formData;
}

describe("catalog management actions", () => {
  beforeEach(() => {
    cacheMocks.revalidatePath.mockReset();
    guardMocks.requireAdmin.mockReset();
    uploadMocks.storeCatalogImageUpload.mockReset();
    Object.values(serviceMocks).forEach((mock) => mock.mockReset());
    guardMocks.requireAdmin.mockResolvedValue({ kind: "ADMIN", userId: "admin-user-1" });
    serviceMocks.createManagedSku.mockResolvedValue({ productId: "product-1", skuId: "sku-1" });
  });

  it("stores an uploaded image and links its immutable asset metadata to the new SKU", async () => {
    const image = new File([new Uint8Array([1, 2, 3])], "new-product.png", {
      type: "image/png",
    });
    const imageAsset = {
      byteSize: 3,
      contentSha256: "a".repeat(64),
      mimeType: "image/png",
      originalFileName: "new-product.png",
      storageKey: `sha256/aa/${"a".repeat(64)}.png`,
    };
    uploadMocks.storeCatalogImageUpload.mockResolvedValue(imageAsset);

    const result = await createSkuAction({ status: "idle" }, createSkuForm(image));

    expect(result.status).toBe("success");
    expect(uploadMocks.storeCatalogImageUpload).toHaveBeenCalledWith({
      file: image,
      skuCode: "TZX-077-1",
    });
    expect(serviceMocks.createManagedSku).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: expect.objectContaining({ imageAsset }),
      }),
    );
  });

  it("creates a SKU without an asset when no image is selected", async () => {
    const result = await createSkuAction({ status: "idle" }, createSkuForm());

    expect(result.status).toBe("success");
    expect(uploadMocks.storeCatalogImageUpload).not.toHaveBeenCalled();
    expect(serviceMocks.createManagedSku).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: expect.objectContaining({
          cargoUnitPriceMilliYuan: 8_000,
        }),
      }),
    );
    expect(serviceMocks.createManagedSku.mock.calls[0]?.[0].product)
      .not.toHaveProperty("cargoUnitPriceMilliYuan");
  });

  it("stores a replacement image when an administrator updates a SKU", async () => {
    const image = new File([new Uint8Array([4, 5, 6])], "replacement.webp", {
      type: "image/webp",
    });
    const imageAsset = {
      byteSize: 3,
      contentSha256: "b".repeat(64),
      mimeType: "image/webp",
      originalFileName: "replacement.webp",
      storageKey: `sha256/bb/${"b".repeat(64)}.webp`,
    };
    uploadMocks.storeCatalogImageUpload.mockResolvedValue(imageAsset);
    const formData = new FormData();
    formData.set("skuId", "00000000-0000-4000-8000-000000000077");
    formData.set("skuCode", "TZX-077-1");
    formData.set("defaultPriceYuan", "3.10");
    formData.set("cargoPriceYuan", "8.50");
    formData.set("productUrl", "https://example.test/new-product");
    formData.set("specification", "20*10cm");
    formData.set("color", "蓝色");
    formData.set("combination", "单件");
    formData.set("weightGrams", "68");
    formData.set("saleStatus", "SELLABLE");
    formData.set("reason", "替换错误图片");
    formData.set("image", image);

    const result = await updateSkuAction({ status: "idle" }, formData);

    expect(result.status).toBe("success");
    expect(uploadMocks.storeCatalogImageUpload).toHaveBeenCalledWith({
      file: image,
      skuCode: "TZX-077-1",
    });
    expect(serviceMocks.updateManagedSku).toHaveBeenCalledWith(
      expect.objectContaining({ cargoUnitPriceMilliYuan: 8_500, imageAsset }),
    );
  });
});
