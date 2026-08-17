"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { auditLogs, skuAliases } from "@/db/schema";
import { requireAdmin } from "@/modules/identity/guards";
import { refreshActiveImportPreviewsForAlias } from "@/modules/order-import/service";
import type { ActionState } from "@/shared/action-state";
import {
  batchManageSkus,
  CatalogManagementError,
  createManagedSku,
  deleteManagedSku,
  restoreManagedSku,
  updateManagedProduct,
  updateManagedSku,
} from "./sku-management-service";
import { CatalogImageUploadError, storeCatalogImageUpload } from "./catalog-image-upload";

const moneySchema = z.string().trim()
  .regex(/^\d+(?:\.\d{1,3})?$/, "价格最多保留三位小数")
  .transform((value) => Math.round(Number(value) * 1_000))
  .refine(Number.isSafeInteger, "价格超出系统支持范围");
const nullableText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().max(500).nullable(),
);
const nonNegativeIntegerSchema = z.coerce.number().int().min(0);

function validationError(error: z.ZodError): ActionState {
  return { fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>, status: "error" };
}

function catalogActionError(error: unknown, fallback: string): ActionState {
  if (error instanceof CatalogImageUploadError) {
    return { message: error.message, status: "error" };
  }
  return error instanceof CatalogManagementError
    ? { message: error.message, status: "error" }
    : { message: fallback, status: "error" };
}

function revalidateCatalog() {
  revalidatePath("/admin/catalog");
  revalidatePath("/admin/inventory");
  revalidatePath("/portal/catalog");
  revalidatePath("/admin");
}

const sharedSkuFields = {
  color: nullableText,
  combination: nullableText,
  defaultPriceMilliYuan: moneySchema,
  initialStock: nonNegativeIntegerSchema,
  productUrl: nullableText,
  reason: z.string().trim().min(2).max(500),
  saleStatus: z.enum(["SELLABLE", "NOT_SELLABLE"]),
  skuCode: z.string().trim().min(2).max(80),
  specification: nullableText,
  weightGrams: nonNegativeIntegerSchema,
};
const createSkuSchema = z.discriminatedUnion("productMode", [
  z.object({
    ...sharedSkuFields,
    cargoPriceMilliYuan: moneySchema,
    linkText: nullableText,
    productMode: z.literal("CREATE"),
    productName: z.string().trim().min(1).max(200),
    sourceSequence: z.string().trim().min(1).max(64),
  }),
  z.object({ ...sharedSkuFields, productId: z.string().uuid(), productMode: z.literal("EXISTING") }),
]);

export async function createSkuAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = createSkuSchema.safeParse({
    cargoPriceMilliYuan: formData.get("cargoPriceYuan"), color: formData.get("color"),
    combination: formData.get("combination"), defaultPriceMilliYuan: formData.get("defaultPriceYuan"),
    initialStock: formData.get("initialStock"), linkText: formData.get("linkText"),
    productId: formData.get("productId"), productMode: formData.get("productMode"),
    productName: formData.get("productName"), productUrl: formData.get("productUrl"),
    reason: formData.get("reason"), saleStatus: formData.get("saleStatus"),
    skuCode: formData.get("skuCode"), sourceSequence: formData.get("sourceSequence"),
    specification: formData.get("specification"), weightGrams: formData.get("weightGrams"),
  });
  if (!parsed.success) return validationError(parsed.error);
  try {
    const input = parsed.data;
    const imageValue = formData.get("image");
    const imageAsset = imageValue instanceof File && imageValue.size > 0
      ? await storeCatalogImageUpload({ file: imageValue, skuCode: input.skuCode })
      : undefined;
    await createManagedSku({
      actorId: principal.userId,
      product: input.productMode === "CREATE"
        ? { cargoUnitPriceMilliYuan: input.cargoPriceMilliYuan, linkText: input.linkText, mode: "CREATE", name: input.productName, sourceSequence: input.sourceSequence }
        : { mode: "EXISTING", productId: input.productId },
      reason: input.reason,
      sku: { color: input.color, combination: input.combination, defaultUnitPriceMilliYuan: input.defaultPriceMilliYuan, imageAsset, initialStock: input.initialStock, productUrl: input.productUrl, saleStatus: input.saleStatus, skuCode: input.skuCode, specification: input.specification, weightGrams: input.weightGrams },
    });
  } catch (error) {
    return catalogActionError(error, "标准 SKU 已存在或数据保存失败。");
  }
  revalidateCatalog();
  return { message: "SKU 已创建，商品资料与初始库存已保存。", status: "success" };
}

const updateProductSchema = z.object({
  cargoUnitPriceMilliYuan: moneySchema, linkText: nullableText,
  name: z.string().trim().min(1).max(200), productId: z.string().uuid(),
  reason: z.string().trim().min(2).max(500), sourceSequence: z.string().trim().min(1).max(64),
});
export async function updateProductAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = updateProductSchema.safeParse({ cargoUnitPriceMilliYuan: formData.get("cargoPriceYuan"), linkText: formData.get("linkText"), name: formData.get("productName"), productId: formData.get("productId"), reason: formData.get("reason"), sourceSequence: formData.get("sourceSequence") });
  if (!parsed.success) return validationError(parsed.error);
  try { await updateManagedProduct({ actorId: principal.userId, ...parsed.data }); }
  catch (error) { return catalogActionError(error, "商品资料保存失败。"); }
  revalidateCatalog();
  return { message: "商品资料已保存，同组 SKU 已同步使用新的货品价格。", status: "success" };
}

const updateSkuSchema = z.object({
  color: nullableText, combination: nullableText, defaultUnitPriceMilliYuan: moneySchema,
  productUrl: nullableText, reason: z.string().trim().min(2).max(500),
  saleStatus: z.enum(["SELLABLE", "NOT_SELLABLE"]), skuCode: z.string().trim().min(2).max(80),
  skuId: z.string().uuid(), specification: nullableText, weightGrams: nonNegativeIntegerSchema,
});
export async function updateSkuAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = updateSkuSchema.safeParse({ color: formData.get("color"), combination: formData.get("combination"), defaultUnitPriceMilliYuan: formData.get("defaultPriceYuan"), productUrl: formData.get("productUrl"), reason: formData.get("reason"), saleStatus: formData.get("saleStatus"), skuCode: formData.get("skuCode"), skuId: formData.get("skuId"), specification: formData.get("specification"), weightGrams: formData.get("weightGrams") });
  if (!parsed.success) return validationError(parsed.error);
  try {
    const imageValue = formData.get("image");
    const imageAsset = imageValue instanceof File && imageValue.size > 0
      ? await storeCatalogImageUpload({ file: imageValue, skuCode: parsed.data.skuCode })
      : undefined;
    await updateManagedSku({ actorId: principal.userId, imageAsset, ...parsed.data });
  }
  catch (error) { return catalogActionError(error, "SKU 资料保存失败。"); }
  revalidateCatalog();
  return { message: "SKU 资料已保存。", status: "success" };
}

const deleteSchema = z.object({ reason: z.string().trim().min(2).max(500), skuId: z.string().uuid() });
export async function deleteSkuAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = deleteSchema.safeParse({ reason: formData.get("reason"), skuId: formData.get("skuId") });
  if (!parsed.success) return validationError(parsed.error);
  try {
    const result = await deleteManagedSku({ actorId: principal.userId, ...parsed.data });
    revalidateCatalog();
    return { message: result.mode === "DELETED" ? "SKU 已删除。" : "SKU 已归档并从新业务中隐藏。", status: "success" };
  } catch (error) { return catalogActionError(error, "SKU 删除失败。"); }
}

export async function restoreSkuAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = deleteSchema.safeParse({ reason: formData.get("reason"), skuId: formData.get("skuId") });
  if (!parsed.success) return validationError(parsed.error);
  try {
    await restoreManagedSku({ actorId: principal.userId, ...parsed.data });
  } catch (error) {
    return catalogActionError(error, "SKU 恢复失败。");
  }
  revalidateCatalog();
  return { message: "SKU 已恢复为不可售，请核对资料和库存后再启用销售。", status: "success" };
}

const batchSchema = z.object({
  mode: z.enum(["SET_STATUS", "MOVE", "DELETE"]), productId: z.string().uuid().optional(),
  reason: z.string().trim().min(2).max(500), saleStatus: z.enum(["SELLABLE", "NOT_SELLABLE"]).optional(),
  skuIds: z.array(z.string().uuid()).min(1).max(100),
});
export async function batchManageSkusAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = batchSchema.safeParse({ mode: formData.get("mode"), productId: formData.get("productId") || undefined, reason: formData.get("reason"), saleStatus: formData.get("saleStatus") || undefined, skuIds: formData.getAll("skuIds") });
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;
  if (input.mode === "MOVE" && !input.productId) return { message: "请选择目标商品。", status: "error" };
  if (input.mode === "SET_STATUS" && !input.saleStatus) return { message: "请选择销售状态。", status: "error" };
  try {
    const result = await batchManageSkus(input.mode === "DELETE"
      ? { actorId: principal.userId, mode: "DELETE", reason: input.reason, skuIds: input.skuIds }
      : input.mode === "MOVE"
        ? { actorId: principal.userId, mode: "MOVE", productId: input.productId!, reason: input.reason, skuIds: input.skuIds }
        : { actorId: principal.userId, mode: "SET_STATUS", reason: input.reason, saleStatus: input.saleStatus!, skuIds: input.skuIds });
    revalidateCatalog();
    return { message: `已处理 ${result.affectedCount} 个 SKU。`, status: "success" };
  } catch (error) { return catalogActionError(error, "批量操作失败，未修改任何 SKU。"); }
}

const aliasSchema = z.object({ externalSku: z.string().trim().min(1, "请填写店铺 SKU").max(160), skuId: z.string().uuid(), storeId: z.string().uuid() });
export async function createSkuAliasAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = aliasSchema.safeParse({ externalSku: formData.get("externalSku"), skuId: formData.get("aliasSkuId"), storeId: formData.get("storeId") });
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(skuAliases).values(input);
      await tx.insert(auditLogs).values({ action: "SKU_ALIAS_CREATED", actorId: principal.userId, actorType: "ADMIN", afterJson: { externalSku: input.externalSku, storeId: input.storeId }, beforeJson: {}, entityId: input.skuId, entityType: "SKU_ALIAS", reason: "管理员建立店铺 SKU 映射" });
      await refreshActiveImportPreviewsForAlias(tx, { actorUserId: principal.userId, externalSku: input.externalSku, skuId: input.skuId, storeId: input.storeId });
    });
  } catch { return { message: "该店铺 SKU 映射已存在，请勿重复添加。", status: "error" }; }
  revalidatePath("/admin/catalog");
  return { message: "店铺 SKU 映射已保存。", status: "success" };
}
