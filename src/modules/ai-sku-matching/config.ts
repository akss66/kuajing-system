const APPROVED_MODEL = "deepseek-v4-flash" as const;

export type EnabledAiSkuMatchConfig = {
  apiKey: string;
  enabled: true;
  model: typeof APPROVED_MODEL;
};

export type AiSkuMatchConfig = EnabledAiSkuMatchConfig | { enabled: false };

export function readAiSkuMatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): AiSkuMatchConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  const model = env.DEEPSEEK_MODEL?.trim() || APPROVED_MODEL;
  if (
    env.AI_SKU_MATCH_ENABLED !== "true" ||
    !apiKey ||
    model !== APPROVED_MODEL
  ) {
    return { enabled: false };
  }
  return { apiKey, enabled: true, model: APPROVED_MODEL };
}
