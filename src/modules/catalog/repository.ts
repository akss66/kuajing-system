import { and, eq, isNull } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";
import { skuAliases } from "@/db/schema";

import type { ResolveStandardSkuInput } from "./types";

export async function resolveStandardSku(
  tx: DbTransaction,
  input: ResolveStandardSkuInput,
): Promise<string | null> {
  const [storeAlias] = await tx
    .select({ skuId: skuAliases.skuId })
    .from(skuAliases)
    .where(
      and(
        eq(skuAliases.storeId, input.storeId),
        eq(skuAliases.externalSku, input.externalSku),
        eq(skuAliases.active, true),
      ),
    )
    .limit(1);

  if (storeAlias) return storeAlias.skuId;

  const [globalAlias] = await tx
    .select({ skuId: skuAliases.skuId })
    .from(skuAliases)
    .where(
      and(
        isNull(skuAliases.storeId),
        eq(skuAliases.externalSku, input.externalSku),
        eq(skuAliases.active, true),
      ),
    )
    .limit(1);

  return globalAlias?.skuId ?? null;
}
