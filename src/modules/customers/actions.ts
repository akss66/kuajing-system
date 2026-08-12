"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/modules/identity/guards";
import type { ActionState } from "@/shared/action-state";

import {
  createStore,
  provisionCustomerWithStore,
  setCustomerStatus,
  setStoreStatus,
  updateCustomer,
  updateStore,
} from "./service";

const createCustomerSchema = z.object({
  code: z.string().trim().min(2).max(40),
  customerName: z.string().trim().min(2).max(160),
  email: z.email(),
  password: z.string().min(12),
  reason: z.string().trim().min(1).max(500),
  storeName: z.string().trim().min(2).max(160),
});

const updateCustomerSchema = z.object({
  code: z.string().trim().min(2).max(40),
  contactName: z.string().trim().max(120).optional(),
  contactWechat: z.string().trim().max(120).optional(),
  customerId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  reason: z.string().trim().min(1).max(500),
});

const createStoreSchema = z.object({
  customerId: z.string().uuid(),
  externalStoreCode: z.string().trim().max(120).optional(),
  name: z.string().trim().min(2).max(160),
  platform: z.string().trim().min(1).max(40).optional(),
  reason: z.string().trim().min(1).max(500),
});

const updateStoreSchema = z.object({
  externalStoreCode: z.string().trim().max(120).optional(),
  name: z.string().trim().min(2).max(160),
  platform: z.string().trim().min(1).max(40).optional(),
  reason: z.string().trim().min(1).max(500),
  storeId: z.string().uuid(),
});

const customerStatusSchema = z.object({
  customerId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["ACTIVE", "DISABLED"]),
});

const storeStatusSchema = z.object({
  customerId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["ACTIVE", "DISABLED"]),
  storeId: z.string().uuid(),
});

function validationState(error: z.ZodError): ActionState {
  return {
    fieldErrors: z.flattenError(error).fieldErrors as Record<string, string[]>,
    status: "error",
  };
}

function revalidateCustomerManagement(customerId: string) {
  revalidatePath("/admin/customers");
  revalidatePath(`/admin/customers/${customerId}`);
}

export async function createCustomerWithStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const principal = await requireAdmin();
  const parsed = createCustomerSchema.safeParse({
    code: formData.get("code"),
    customerName: formData.get("customerName"),
    email: formData.get("email"),
    password: formData.get("password"),
    reason: formData.get("reason"),
    storeName: formData.get("storeName"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  try {
    await provisionCustomerWithStore({
      actorId: principal.userId,
      ...parsed.data,
    });
  } catch {
    return {
      message: "Customer code, store name, or login email already exists.",
      status: "error",
    };
  }

  revalidatePath("/admin/customers");
  revalidatePath("/admin");
  return { message: "Customer and store created.", status: "success" };
}

export async function updateCustomerAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = updateCustomerSchema.safeParse({
    code: formData.get("code"),
    contactName: formData.get("contactName") || undefined,
    contactWechat: formData.get("contactWechat") || undefined,
    customerId: formData.get("customerId"),
    name: formData.get("name"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  await updateCustomer({ actor, ...parsed.data });
  revalidateCustomerManagement(parsed.data.customerId);
  return { status: "success" };
}

export async function createStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = createStoreSchema.safeParse({
    customerId: formData.get("customerId"),
    externalStoreCode: formData.get("externalStoreCode") || undefined,
    name: formData.get("name"),
    platform: formData.get("platform") || undefined,
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  await createStore({ actor, ...parsed.data });
  revalidateCustomerManagement(parsed.data.customerId);
  return { status: "success" };
}

export async function updateStoreAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const customerId = String(formData.get("customerId") ?? "");
  const parsed = updateStoreSchema.safeParse({
    externalStoreCode: formData.get("externalStoreCode") || undefined,
    name: formData.get("name"),
    platform: formData.get("platform") || undefined,
    reason: formData.get("reason"),
    storeId: formData.get("storeId"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  await updateStore({ actor, ...parsed.data });
  revalidateCustomerManagement(customerId);
  return { status: "success" };
}

export async function setCustomerStatusAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = customerStatusSchema.safeParse({
    customerId: formData.get("customerId"),
    reason: formData.get("reason"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  await setCustomerStatus({ actor, ...parsed.data });
  revalidateCustomerManagement(parsed.data.customerId);
  return { status: "success" };
}

export async function setStoreStatusAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireAdmin();
  const parsed = storeStatusSchema.safeParse({
    customerId: formData.get("customerId"),
    reason: formData.get("reason"),
    status: formData.get("status"),
    storeId: formData.get("storeId"),
  });
  if (!parsed.success) {
    return validationState(parsed.error);
  }

  await setStoreStatus({
    actor,
    reason: parsed.data.reason,
    status: parsed.data.status,
    storeId: parsed.data.storeId,
  });
  revalidateCustomerManagement(parsed.data.customerId);
  return { status: "success" };
}
