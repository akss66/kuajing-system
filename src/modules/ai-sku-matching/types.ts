export type AiSkuMatchCandidateInput = {
  id: string;
  skuCode: string;
  productName: string;
  name: string;
  specification: string | null;
  color: string | null;
  combination: string | null;
};

export type AiSkuMatchRowInput = {
  rowId: string;
  externalSku: string | null;
  productName: string | null;
  productAttributes: string | null;
  candidateIds: string[];
};

export type AiSkuMatchProviderInput = {
  userId: string;
  candidates: AiSkuMatchCandidateInput[];
  rows: AiSkuMatchRowInput[];
};

export type AiSkuMatchConfidence = "HIGH" | "MEDIUM" | "LOW";

export type AiSkuMatchProviderResult = {
  completionTokens: number | null;
  matches: Array<{
    rowId: string;
    suggestions: Array<{
      candidateId: string;
      confidence: AiSkuMatchConfidence;
      reason: string;
    }>;
  }>;
  promptTokens: number | null;
};

export interface AiSkuMatchProvider {
  suggest(input: AiSkuMatchProviderInput): Promise<AiSkuMatchProviderResult>;
}
