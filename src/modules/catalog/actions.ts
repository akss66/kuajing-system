"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import {
  auditLogs,
  customerSkuPrices,
  inventoryBalances,
  products,
  skuAliases,
  skus,
} from "@/db/schema";
import { requireAdmin } from "@/modules/identity/guards";
import { refreshActiveImportPreviewsForAlias } from "@/modules/order-import/service";
import type { ActionState } from "@/shared/action-state";

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,2})?$/, "价格最多保留两位小数")
  .transform((value) => Math.round(Number(value) * 100));

const schema = z.object({
  skuCode: z.string().trim().min(2, "请填写标准 SKU").max(80),
  productName: z.string().trim().min(2, "请填写商品名称").max(200),
  skuName: z.string().trim().min(1, "请填写规格名称").max(200),
  defaultPriceFen: moneySchema,
});

function validationError(error: z.ZodError): ActionState {
  return {
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
    status: "error",
  };
}

export async function createSkuAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = schema.safeParse({
    defaultPriceFen: formData.get("defaultPriceYuan"),
    productName: formData.get("productName"),
    skuCode: formData.get("skuCode"),
    skuName: formData.get("skuName"),
  });
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;

  try {
    await db.transaction(async (tx) => {
    const [product] = await tx
      .insert(products)
      .values({ name: input.productName })
      .returning({ id: products.id });
    const [sku] = await tx
      .insert(skus)
      .values({
        defaultUnitPriceFen: input.defaultPriceFen,
        name: input.skuName,
        productId: product.id,
        skuCode: input.skuCode,
      })
      .returning({ id: skus.id });
    await tx.insert(inventoryBalances).values({ skuId: sku.id, totalQuantity: 0 });
    await tx.insert(auditLogs).values({
      action: "SKU_CREATED",
      actorId: principal.userId,
      actorType: "ADMIN",
      afterJson: { defaultUnitPriceFen: input.defaultPriceFen, skuCode: input.skuCode },
      beforeJson: {},
      entityId: sku.id,
      entityType: "SKU",
      reason: "管理员创建标准 SKU",
    });
    });
  } catch {
    return { message: "标准 SKU 已存在或数据保存失败。", status: "error" };
  }

  revalidatePath("/admin/catalog");
  revalidatePath("/admin/inventory");
  revalidatePath("/admin");
  return { message: "SKU 已创建，并初始化为 0 库存。", status: "success" };
}

const customerPriceSchema = z.object({
  customerId: z.string().uuid(),
  skuId: z.string().uuid(),
  unitPriceFen: moneySchema,
});

export async function setCustomerPriceAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = customerPriceSchema.safeParse({
    customerId: formData.get("customerId"),
    skuId: formData.get("skuId"),
    unitPriceFen: formData.get("unitPriceYuan"),
  });
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;
  try {
    await db.transaction(async (tx) => {
    await tx
      .insert(customerSkuPrices)
      .values(input)
      .onConflictDoUpdate({
        set: { active: true, unitPriceFen: input.unitPriceFen, updatedAt: new Date() },
        target: [customerSkuPrices.customerId, customerSkuPrices.skuId],
      });
    await tx.insert(auditLogs).values({
      action: "CUSTOMER_PRICE_SET",
      actorId: principal.userId,
      actorType: "ADMIN",
      afterJson: { customerId: input.customerId, unitPriceFen: input.unitPriceFen },
      beforeJson: {},
      entityId: input.skuId,
      entityType: "SKU_PRICE",
      reason: "管理员设置客户专属价",
    });
    });
  } catch {
    return { message: "客户专属价保存失败，请检查客户和 SKU。", status: "error" };
  }
  revalidatePath("/admin/catalog");
  return { message: "客户专属价已保存。", status: "success" };
}

const aliasSchema = z.object({
  externalSku: z.string().trim().min(1, "请填写店铺 SKU").max(160),
  skuId: z.string().uuid(),
  storeId: z.string().uuid(),
});

export async function createSkuAliasAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = aliasSchema.safeParse({
    externalSku: formData.get("externalSku"),
    skuId: formData.get("aliasSkuId"),
    storeId: formData.get("storeId"),
  });
  if (!parsed.success) return validationError(parsed.error);
  const input = parsed.data;
  try {
    await db.transaction(async (tx) => {
    await tx.insert(skuAliases).values(input);
    await tx.insert(auditLogs).values({
      action: "SKU_ALIAS_CREATED",
      actorId: principal.userId,
      actorType: "ADMIN",
      afterJson: { externalSku: input.externalSku, storeId: input.storeId },
      beforeJson: {},
      entityId: input.skuId,
      entityType: "SKU_ALIAS",
      reason: "管理员建立店铺 SKU 映射",
    });
    await refreshActiveImportPreviewsForAlias(tx, {
      actorUserId: principal.userId,
      externalSku: input.externalSku,
      skuId: input.skuId,
      storeId: input.storeId,
    });
    });
  } catch {
    return { message: "该店铺 SKU 映射已存在，请勿重复添加。", status: "error" };
  }
  revalidatePath("/admin/catalog");
  return { message: "店铺 SKU 映射已保存。", status: "success" };
}
