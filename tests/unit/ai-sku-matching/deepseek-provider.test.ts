import { describe, expect, it, vi } from "vitest";

import {
  AiSkuMatchProviderError,
  createDeepSeekSkuMatchProvider,
} from "@/modules/ai-sku-matching/deepseek-provider";
import type { AiSkuMatchProviderInput } from "@/modules/ai-sku-matching/types";

const input: AiSkuMatchProviderInput = {
  candidates: [
    {
      color: "红色",
      combination: null,
      id: "00000000-0000-4000-8000-000000000001",
      name: "红色款",
      productName: "宠物牵引绳",
      skuCode: "TZX-001-RED",
      specification: "150×80",
    },
  ],
  rows: [
    {
      candidateIds: ["00000000-0000-4000-8000-000000000001"],
      externalSku: "BAD-SKU-RED",
      productAttributes: "颜色：红色",
      productName: "宠物牵引绳",
      rowId: "00000000-0000-4000-8000-000000000101",
    },
  ],
  userId: "customer_4af9",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function completion(content: string, finishReason = "stop") {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: { content, role: "assistant" },
      },
    ],
    usage: { completion_tokens: 22, prompt_tokens: 120, total_tokens: 142 },
  };
}

describe("DeepSeek SKU match provider", () => {
  it("sends only allowlisted product fields and returns schema-validated suggestions", async () => {
    const fetchMock = vi.fn(async () =>
      response(
        completion(
          JSON.stringify({
            matches: [
              {
                rowId: input.rows[0].rowId,
                suggestions: [
                  {
                    candidateId: input.candidates[0].id,
                    confidence: "HIGH",
                    reason: "商品和颜色一致",
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );
    const provider = createDeepSeekSkuMatchProvider(
      { apiKey: "secret", model: "deepseek-v4-flash" },
      fetchMock,
    );

    const result = await provider.suggest(input);

    expect(result.matches[0]?.suggestions[0]).toMatchObject({
      candidateId: input.candidates[0].id,
      confidence: "HIGH",
    });
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const request = JSON.parse(String(requestInit.body));
    expect(request).toMatchObject({
      max_tokens: 4096,
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
      stream: false,
      thinking: { type: "disabled" },
      user_id: "customer_4af9",
    });
    expect(JSON.stringify(request)).not.toMatch(
      /recipient|address|phone|email|externalOrderNo|subOrder/i,
    );
  });

  it("rejects hallucinated candidate IDs even when the JSON shape is valid", async () => {
    const fetchMock = vi.fn(async () =>
      response(
        completion(
          JSON.stringify({
            matches: [
              {
                rowId: input.rows[0].rowId,
                suggestions: [
                  {
                    candidateId: "00000000-0000-4000-8000-000000000999",
                    confidence: "HIGH",
                    reason: "虚构候选",
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );
    const provider = createDeepSeekSkuMatchProvider(
      { apiKey: "secret", model: "deepseek-v4-flash" },
      fetchMock,
    );

    await expect(provider.suggest(input)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 429 and empty invalid JSON once, but never retries auth failures", async () => {
    const valid = completion(
      JSON.stringify({
        matches: [{ rowId: input.rows[0].rowId, suggestions: [] }],
      }),
    );
    const rateLimited = vi
      .fn()
      .mockResolvedValueOnce(response({ error: { message: "slow down" } }, 429))
      .mockResolvedValueOnce(response(valid));
    await expect(
      createDeepSeekSkuMatchProvider(
        { apiKey: "secret", model: "deepseek-v4-flash" },
        rateLimited,
      ).suggest(input),
    ).resolves.toBeDefined();
    expect(rateLimited).toHaveBeenCalledTimes(2);

    const empty = vi
      .fn()
      .mockResolvedValueOnce(response(completion("")))
      .mockResolvedValueOnce(response(valid));
    await expect(
      createDeepSeekSkuMatchProvider(
        { apiKey: "secret", model: "deepseek-v4-flash" },
        empty,
      ).suggest(input),
    ).resolves.toBeDefined();
    expect(empty).toHaveBeenCalledTimes(2);

    const unauthorized = vi.fn(async () => response({ error: {} }, 401));
    await expect(
      createDeepSeekSkuMatchProvider(
        { apiKey: "secret", model: "deepseek-v4-flash" },
        unauthorized,
      ).suggest(input),
    ).rejects.toBeInstanceOf(AiSkuMatchProviderError);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated completions instead of consuming partial suggestions", async () => {
    const provider = createDeepSeekSkuMatchProvider(
      { apiKey: "secret", model: "deepseek-v4-flash" },
      vi.fn(async () => response(completion('{"matches":[', "length"))),
    );

    await expect(provider.suggest(input)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
