import { sql } from "drizzle-orm";
import { expect, test } from "vitest";

import { db } from "@/db/client";

test("connects to PostgreSQL", async () => {
  const result = await db.execute(sql`select 1 as ok`);

  expect(result[0]?.ok).toBe(1);
});
