import { afterEach, describe, expect, it } from "vitest";

import { readAiSkuMatchConfig } from "@/modules/ai-sku-matching/config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env.AI_SKU_MATCH_ENABLED = originalEnv.AI_SKU_MATCH_ENABLED;
  process.env.DEEPSEEK_API_KEY = originalEnv.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_MODEL = originalEnv.DEEPSEEK_MODEL;
});

describe("readAiSkuMatchConfig", () => {
  it("fails closed unless the global gate and secret are both configured", () => {
    delete process.env.AI_SKU_MATCH_ENABLED;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_MODEL;
    expect(readAiSkuMatchConfig()).toEqual({ enabled: false });

    process.env.AI_SKU_MATCH_ENABLED = "true";
    expect(readAiSkuMatchConfig()).toEqual({ enabled: false });
  });

  it("accepts only the approved DeepSeek model without exposing the key", () => {
    process.env.AI_SKU_MATCH_ENABLED = "true";
    process.env.DEEPSEEK_API_KEY = "test-secret";
    process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";

    expect(readAiSkuMatchConfig()).toEqual({
      apiKey: "test-secret",
      enabled: true,
      model: "deepseek-v4-flash",
    });

    process.env.DEEPSEEK_MODEL = "attacker-controlled-model";
    expect(readAiSkuMatchConfig()).toEqual({ enabled: false });
  });
});
