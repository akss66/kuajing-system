import { z } from "zod";

import type { JifengCredentials } from "./types";

const configSchema = z.object({
  JIFENG_ACCESS_TOKEN: z.string().min(1),
  JIFENG_BASE_URL: z.url().transform((value) => value.replace(/\/$/, "")),
  JIFENG_CLIENT_ID: z.string().min(1),
  JIFENG_CLIENT_SECRET: z.string().min(1),
  JIFENG_LOGISTICS_ID: z.coerce.number().int().positive(),
  JIFENG_REFRESH_TOKEN: z.string().min(1).optional(),
  JIFENG_USER_ID: z.string().min(1),
  JIFENG_WAREHOUSE_CODE: z.string().min(1),
});

export type JifengIntegrationConfig = JifengCredentials & {
  logisticsId: number;
  warehouseCode: string;
};

export function readJifengConfig(
  environment: Record<string, string | undefined> = process.env,
): JifengIntegrationConfig {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("极风集成配置不完整，请检查服务端环境变量");
  }
  return {
    accessToken: parsed.data.JIFENG_ACCESS_TOKEN,
    baseUrl: parsed.data.JIFENG_BASE_URL,
    clientId: parsed.data.JIFENG_CLIENT_ID,
    clientSecret: parsed.data.JIFENG_CLIENT_SECRET,
    logisticsId: parsed.data.JIFENG_LOGISTICS_ID,
    refreshToken: parsed.data.JIFENG_REFRESH_TOKEN,
    userId: parsed.data.JIFENG_USER_ID,
    warehouseCode: parsed.data.JIFENG_WAREHOUSE_CODE,
  };
}
