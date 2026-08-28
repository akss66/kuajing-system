import type { AiSkuMatchCandidateInput } from "./types";

type MatchSource = {
  externalSku: string | null;
  productName: string | null;
  productAttributes: string | null;
};

export function normalizeSkuMatchText(value: string | null | undefined) {
  if (!value) return "";
  return Array.from(value.normalize("NFKC").toLocaleLowerCase("zh-CN"))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

function ngrams(value: string, size = 2) {
  if (!value) return new Set<string>();
  if (value.length <= size) return new Set([value]);
  return new Set(
    Array.from({ length: value.length - size + 1 }, (_, index) =>
      value.slice(index, index + size),
    ),
  );
}

function diceSimilarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftParts = ngrams(left);
  const rightParts = ngrams(right);
  let shared = 0;
  for (const part of leftParts) {
    if (rightParts.has(part)) shared += 1;
  }
  return (2 * shared) / (leftParts.size + rightParts.size);
}

function commonPrefixRatio(left: string, right: string) {
  const comparedLength = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < comparedLength && left[shared] === right[shared]) shared += 1;
  return comparedLength === 0 ? 0 : shared / comparedLength;
}

function candidateScore(source: MatchSource, candidate: AiSkuMatchCandidateInput) {
  const sourceCode = normalizeSkuMatchText(source.externalSku);
  const candidateCode = normalizeSkuMatchText(candidate.skuCode);
  const sourceDescription = normalizeSkuMatchText(
    [source.productName, source.productAttributes].filter(Boolean).join(" "),
  );
  const candidateDescription = normalizeSkuMatchText(
    [
      candidate.productName,
      candidate.name,
      candidate.specification,
      candidate.color,
      candidate.combination,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return (
    diceSimilarity(sourceCode, candidateCode) * 6 +
    commonPrefixRatio(sourceCode, candidateCode) * 2 +
    diceSimilarity(sourceDescription, candidateDescription) * 4 +
    diceSimilarity(
      `${sourceCode}${sourceDescription}`,
      `${candidateCode}${candidateDescription}`,
    ) *
      2
  );
}

export function shortlistSkuCandidates<T extends AiSkuMatchCandidateInput>(
  source: MatchSource,
  candidates: readonly T[],
  limit = 20,
) {
  const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 20));
  return [...candidates]
    .map((candidate) => ({ candidate, score: candidateScore(source, candidate) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.skuCode.localeCompare(right.candidate.skuCode, "zh-CN") ||
        left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, boundedLimit)
    .map(({ candidate }) => candidate);
}
