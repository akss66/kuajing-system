import { sql } from "drizzle-orm";

import type { DbTransaction } from "@/db/client";

export type ActiveOrderUniqueKeyScope = {
  externalOrderNumbers: readonly string[];
  externalSubOrderNumbers: readonly string[];
  storeId: string;
};

const LOCK_CHUNK_SIZE = 10_000;

export async function lockActiveOrderUniqueKeys(
  tx: DbTransaction,
  scopes: readonly ActiveOrderUniqueKeyScope[],
) {
  const lockKeys = [
    ...new Set(
      scopes.flatMap((scope) => [
        ...scope.externalOrderNumbers.map(
          (orderNo) =>
            `order_shipments_store_external_order_unique:${scope.storeId}:${orderNo}`,
        ),
        ...scope.externalSubOrderNumbers.map(
          (subOrderNo) =>
            `order_lines_store_external_sub_order_unique:${scope.storeId}:${subOrderNo}`,
        ),
      ]),
    ),
  ].sort();

  for (let index = 0; index < lockKeys.length; index += LOCK_CHUNK_SIZE) {
    const chunk = lockKeys.slice(index, index + LOCK_CHUNK_SIZE);
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(lock_key, 0))
      from (
        select lock_key
        from unnest(array[
          ${sql.join(
            chunk.map((lockKey) => sql`${lockKey}`),
            sql`, `,
          )}
        ]::text[]) as conflict_keys(lock_key)
        order by lock_key
      ) as ordered_conflict_keys
    `);
  }
}
