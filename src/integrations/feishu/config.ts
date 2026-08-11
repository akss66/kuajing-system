import { z } from "zod";

const configSchema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_CARGO_SHEET_ID: z.string().min(1).optional(),
  FEISHU_CARGO_WIKI_TOKEN: z.string().min(1),
  FEISHU_INTERNAL_CHAT_ID: z.string().min(1),
});

export type FeishuIntegrationConfig = {
  appId: string;
  appSecret: string;
  cargoSheetId?: string;
  cargoWikiToken: string;
  internalChatId: string;
};

export function readFeishuConfig(
  environment: Record<string, string | undefined> = process.env,
): FeishuIntegrationConfig {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("飞书集成配置不完整，请检查服务端环境变量");
  }
  return {
    appId: parsed.data.FEISHU_APP_ID,
    appSecret: parsed.data.FEISHU_APP_SECRET,
    cargoSheetId: parsed.data.FEISHU_CARGO_SHEET_ID,
    cargoWikiToken: parsed.data.FEISHU_CARGO_WIKI_TOKEN,
    internalChatId: parsed.data.FEISHU_INTERNAL_CHAT_ID,
  };
}
