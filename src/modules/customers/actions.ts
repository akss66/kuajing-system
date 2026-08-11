"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { auditLogs, customers, stores } from "@/db/schema";
import { requireAdmin } from "@/modules/identity/guards";

const schema = z.object({
  code: z.string().trim().min(2, "客户编号至少 2 个字符").max(40),
  customerName: z.string().trim().min(2, "请填写客户名称").max(160),
  storeName: z.string().trim().min(2, "请填写店铺名称").max(160),
});

export async function createCustomerWithStoreAction(formData: FormData) {
  const principal = await requireAdmin();
  const input = schema.parse({
    code: formData.get("code"),
    customerName: formData.get("customerName"),
    storeName: formData.get("storeName"),
  });

  await db.transaction(async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({ code: input.code, name: input.customerName })
      .returning({ id: customers.id });
    const [store] = await tx
      .insert(stores)
      .values({ customerId: customer.id, name: input.storeName })
      .returning({ id: stores.id });
    await tx.insert(auditLogs).values({
      action: "CUSTOMER_CREATED",
      actorId: principal.userId,
      actorType: "ADMIN",
      afterJson: { customerName: input.customerName, storeId: store.id, storeName: input.storeName },
      beforeJson: {},
      entityId: customer.id,
      entityType: "CUSTOMER",
      reason: "管理员创建合作客户与店铺",
    });
  });

  revalidatePath("/admin/customers");
  revalidatePath("/admin");
}
