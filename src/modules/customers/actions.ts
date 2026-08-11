"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import { provisionCustomerWithStore } from "./service";

const schema = z.object({
  code: z.string().trim().min(2, "客户编号至少 2 个字符").max(40),
  customerName: z.string().trim().min(2, "请填写客户名称").max(160),
  email: z.email("请填写有效的登录邮箱"),
  password: z.string().min(12, "登录密码至少 12 个字符"),
  storeName: z.string().trim().min(2, "请填写店铺名称").max(160),
});

export async function createCustomerWithStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = schema.safeParse({
    code: formData.get("code"),
    customerName: formData.get("customerName"),
    email: formData.get("email"),
    password: formData.get("password"),
    storeName: formData.get("storeName"),
  });
  if (!parsed.success) {
    return {
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      status: "error",
    };
  }
  const input = parsed.data;

  try {
    await provisionCustomerWithStore({
      actorId: principal.userId,
      ...input,
    });
  } catch {
    return { message: "客户编号、店铺名称或登录邮箱已存在，请检查后重试。", status: "error" };
  }

  revalidatePath("/admin/customers");
  revalidatePath("/admin");
  return { message: "客户与店铺已创建。", status: "success" };
}
