import type {
  CargoInheritedField,
  CargoParseResult,
  MigrationIssue,
  ParsedCargoRow,
} from "@/modules/feishu/cargo-types";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const REQUIRED_HEADER_KEYS = [
  "sku",
  "\u540d\u79f0",
  "\u91c7\u8d2d\u4ef7",
  "\u603b\u5e93\u5b58",
  "\u72b6\u6001",
] as const;

const HEADER_ALIASES = {
  combination: ["\u7ec4\u5408\u9500\u552e"],
  color: ["\u989c\u8272"],
  image: ["\u56fe\u7247"],
  link: ["\u94fe\u63a5\u6587\u5b57"],
  name: ["\u540d\u79f0"],
  price: ["\u91c7\u8d2d\u4ef7"],
  quantity: ["\u603b\u5e93\u5b58", "\u603b\u5e93\u5b58/\u4ef6"],
  sequence: ["\u5e8f\u53f7"],
  sku: ["sku"],
  status: ["\u72b6\u6001"],
  specification: ["\u89c4\u683c"],
  weight: ["\u91cd\u91cf"],
} satisfies Record<string, string[]>;

type HeaderMap = Record<keyof typeof HEADER_ALIASES, number>;

type LinkValue = {
  text: string;
  url: string;
};

type LinkResolution =
  | { kind: "invalid" }
  | { kind: "missing" }
  | { kind: "valid"; value: LinkValue };

type GroupFieldState = {
  rowNumber: number;
  value: string | number | null;
};

type GroupContext = {
  combination: GroupFieldState | null;
  image: GroupFieldState | null;
  price: GroupFieldState | null;
  productGroupKey: GroupFieldState | null;
  productName: GroupFieldState | null;
  productUrl: ({ text: string; url: string } & { rowNumber: number }) | null;
  specification: GroupFieldState | null;
  weight: GroupFieldState | null;
};

function normalizeHeaderCell(value: unknown) {
  return extractDisplayText(value).replace(/\s+/g, "").toLowerCase();
}

function extractDisplayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractDisplayText(entry)).join("").trim();
  }
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }
    if ("link" in value && typeof value.link === "string") {
      return value.link.trim();
    }
  }
  return "";
}

function collectLinkTargets(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectLinkTargets(entry));
  }
  if (typeof value === "object") {
    const nested = value as { children?: unknown; link?: unknown };
    const links =
      typeof nested.link === "string" && nested.link.trim().length > 0
        ? [nested.link.trim()]
        : [];
    if ("children" in nested) {
      return [...links, ...collectLinkTargets(nested.children)];
    }
    return links;
  }
  return [];
}

function collectFileTokens(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectFileTokens(entry));
  }
  if (typeof value === "object") {
    const nested = value as { children?: unknown; fileToken?: unknown };
    const tokens =
      typeof nested.fileToken === "string" && nested.fileToken.trim().length > 0
        ? [nested.fileToken.trim()]
        : [];
    if ("children" in nested) {
      return [...tokens, ...collectFileTokens(nested.children)];
    }
    return tokens;
  }
  return [];
}

function isAbsoluteHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function buildIssue(input: {
  code: string;
  message: string;
  sourceRowNumber: number;
}): MigrationIssue {
  return {
    code: input.code,
    message: input.message,
    severity: "BLOCKING",
    sourceRowNumber: input.sourceRowNumber,
  };
}

function parseScaledDecimal(raw: string, scale: number) {
  const normalized = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  const scaleDigits = String(scale).length - 1;
  if (fractionalPart.length > scaleDigits) return null;

  const digits = `${wholePart}${fractionalPart.padEnd(scaleDigits, "0")}`;
  const scaled = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(scaled) || scaled < 0) return null;
  return scaled;
}

function parseYuanToFen(value: unknown) {
  const text = extractDisplayText(value).replace(/^[\u00a5\uffe5]/, "");
  if (text.length === 0) return null;
  return parseScaledDecimal(text, 100);
}

function parseNonNegativeSafeInteger(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
  }

  const text = extractDisplayText(value);
  if (text.length === 0 || !/^\d+$/.test(text)) return null;

  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseWeightGrams(value: unknown) {
  const raw = extractDisplayText(value);
  if (raw.length === 0) return null;

  const normalized = raw.replace(/\s+/g, "").toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(kg|g|\u514b)$/.exec(normalized);
  if (!match) return null;

  const [, amount, unit] = match;
  const grams =
    unit === "kg" ? parseScaledDecimal(amount, 1000) : parseScaledDecimal(amount, 1);
  if (grams === null || grams > MAX_SAFE_INTEGER) return null;
  return grams;
}

function parseSaleStatus(value: unknown) {
  const normalized = extractDisplayText(value).replace(/\s+/g, "").toLowerCase();
  if (normalized.length === 0) return { kind: "missing" } as const;
  if (
    normalized === "\u53ef\u552e" ||
    normalized === "sellable"
  ) {
    return { kind: "value", value: "SELLABLE" as const };
  }
  if (
    normalized === "\u4e0d\u53ef\u552e" ||
    normalized === "notsellable"
  ) {
    return { kind: "value", value: "NOT_SELLABLE" as const };
  }
  return { kind: "invalid" } as const;
}

function resolveLink(value: unknown): LinkResolution {
  const text = extractDisplayText(value);
  const urls = [...new Set(collectLinkTargets(value))];
  if (urls.length === 1) {
    if (isAbsoluteHttpUrl(urls[0])) {
      return { kind: "valid", value: { text: text || urls[0], url: urls[0] } };
    }
    return { kind: "invalid" };
  }
  if (urls.length > 1) {
    return { kind: "invalid" };
  }
  if (isAbsoluteHttpUrl(text)) {
    return { kind: "valid", value: { text, url: text } };
  }
  return { kind: "missing" };
}

function resolveImageToken(value: unknown) {
  const tokens = [...new Set(collectFileTokens(value))];
  return tokens.length === 1 ? tokens[0] : null;
}

function findHeaderRow(values: unknown[][]) {
  for (let rowIndex = 0; rowIndex < Math.min(values.length, 20); rowIndex += 1) {
    const normalized = values[rowIndex].map((cell) => normalizeHeaderCell(cell));
    const headerKeys = new Set(normalized);
    if (REQUIRED_HEADER_KEYS.every((header) => headerKeys.has(header))) {
      return rowIndex;
    }
  }
  return -1;
}

function createHeaderMap(row: unknown[]) {
  const map = {} as HeaderMap;
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [keyof HeaderMap, string[]]
  >) {
    const index = row.findIndex((cell) => aliases.includes(normalizeHeaderCell(cell)));
    map[key] = index;
  }
  return map;
}

function isBlankRow(row: unknown[]) {
  return row.every((cell) => extractDisplayText(cell).length === 0);
}

function createEmptyContext(): GroupContext {
  return {
    combination: null,
    image: null,
    price: null,
    productGroupKey: null,
    productName: null,
    productUrl: null,
    specification: null,
    weight: null,
  };
}

function buildSkuName(input: {
  color: null | string;
  combination: null | string;
  productName: string;
  specification: null | string;
}) {
  const parts = [input.specification, input.color, input.combination].filter(
    (value): value is string => value !== null && value.length > 0,
  );
  return parts.length > 0 ? parts.join(" / ") : input.productName;
}

function collectDuplicateSkuIssues(input: {
  headerMap: HeaderMap;
  headerRowIndex: number;
  values: unknown[][];
}) {
  const occurrences = new Map<string, number[]>();

  for (let offset = input.headerRowIndex + 1; offset < input.values.length; offset += 1) {
    const row = input.values[offset] ?? [];
    if (isBlankRow(row)) continue;

    const skuCode = extractDisplayText(row[input.headerMap.sku]);
    if (skuCode.length === 0) continue;

    const rows = occurrences.get(skuCode) ?? [];
    rows.push(offset + 1);
    occurrences.set(skuCode, rows);
  }

  const issues: MigrationIssue[] = [];
  for (const [skuCode, rowNumbers] of occurrences) {
    for (const sourceRowNumber of rowNumbers.slice(1)) {
      issues.push(
        buildIssue({
          code: "CARGO_DUPLICATE_SKU",
          message: `SKU 重复：${skuCode}`,
          sourceRowNumber,
        }),
      );
    }
  }

  return issues;
}

function buildSummary(rows: ParsedCargoRow[]) {
  let totalQuantity = 0;
  let overflowed = false;

  for (const row of rows) {
    if (row.totalQuantity > MAX_SAFE_INTEGER - totalQuantity) {
      overflowed = true;
      break;
    }
    totalQuantity += row.totalQuantity;
  }

  return {
    overflowed,
    summary: {
      imageCount: rows.length,
      productCount: new Set(rows.map((row) => row.productGroupKey)).size,
      skuCount: rows.length,
      totalQuantity: overflowed ? 0 : totalQuantity,
    },
  };
}

export function parseLegacyCargoSheet(values: unknown[][]): CargoParseResult {
  const headerRowIndex = findHeaderRow(values);
  if (headerRowIndex === -1) {
    return {
      headerRowNumber: 0,
      issues: [
        {
          code: "CARGO_HEADER_NOT_FOUND",
          message: "\u672a\u627e\u5230\u65e7\u98de\u4e66\u8d27\u76d8\u8868\u5934",
          severity: "BLOCKING",
        },
      ],
      rows: [],
      summary: {
        imageCount: 0,
        productCount: 0,
        skuCount: 0,
        totalQuantity: 0,
      },
    };
  }

  const headerMap = createHeaderMap(values[headerRowIndex] ?? []);
  const rows: ParsedCargoRow[] = [];
  const issues: MigrationIssue[] = collectDuplicateSkuIssues({
    headerMap,
    headerRowIndex,
    values,
  });
  const context = createEmptyContext();

  for (let offset = headerRowIndex + 1; offset < values.length; offset += 1) {
    const row = values[offset] ?? [];
    if (isBlankRow(row)) {
      const reset = createEmptyContext();
      context.combination = reset.combination;
      context.image = reset.image;
      context.price = reset.price;
      context.productGroupKey = reset.productGroupKey;
      context.productName = reset.productName;
      context.productUrl = reset.productUrl;
      context.specification = reset.specification;
      context.weight = reset.weight;
      continue;
    }

    const sourceRowNumber = offset + 1;
    const inheritedFrom: Partial<Record<CargoInheritedField, number>> = {};

    const explicitGroupKey = extractDisplayText(row[headerMap.sequence]);
    const productGroupKey =
      explicitGroupKey ||
      (typeof context.productGroupKey?.value === "string"
        ? context.productGroupKey.value
        : "");
    if (explicitGroupKey) {
      context.productGroupKey = { rowNumber: sourceRowNumber, value: explicitGroupKey };
    } else if (context.productGroupKey) {
      inheritedFrom.productGroupKey = context.productGroupKey.rowNumber;
    } else {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_PRODUCT_GROUP_KEY",
          message: "\u5e8f\u53f7\u4e0d\u80fd\u4e3a\u7a7a",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const skuCode = extractDisplayText(row[headerMap.sku]);
    if (skuCode.length === 0) {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_SKU",
          message: "SKU \u4e0d\u80fd\u4e3a\u7a7a",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const explicitProductName = extractDisplayText(row[headerMap.name]);
    const productName =
      explicitProductName ||
      (typeof context.productName?.value === "string"
        ? context.productName.value
        : "");
    if (explicitProductName) {
      context.productName = { rowNumber: sourceRowNumber, value: explicitProductName };
    } else if (context.productName) {
      inheritedFrom.productName = context.productName.rowNumber;
    } else {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_PRODUCT_NAME",
          message: "\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const explicitImageToken = resolveImageToken(row[headerMap.image]);
    const imageFileToken =
      explicitImageToken ||
      (typeof context.image?.value === "string" ? context.image.value : "");
    if (explicitImageToken) {
      context.image = { rowNumber: sourceRowNumber, value: explicitImageToken };
    } else if (context.image) {
      inheritedFrom.image = context.image.rowNumber;
    } else {
      issues.push(
        buildIssue({
          code: "CARGO_AMBIGUOUS_IMAGE",
          message:
            "\u56fe\u7247\u5355\u5143\u683c\u5fc5\u987b\u4e14\u53ea\u80fd\u5305\u542b\u4e00\u4e2a fileToken",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const explicitPriceFen = parseYuanToFen(row[headerMap.price]);
    const defaultUnitPriceFen =
      explicitPriceFen ??
      (typeof context.price?.value === "number" ? context.price.value : null);
    if (explicitPriceFen !== null) {
      context.price = { rowNumber: sourceRowNumber, value: explicitPriceFen };
    } else if (extractDisplayText(row[headerMap.price]).length === 0 && context.price) {
      inheritedFrom.price = context.price.rowNumber;
    } else {
      issues.push(
        buildIssue({
          code: "CARGO_INVALID_PRICE",
          message: "\u91c7\u8d2d\u4ef7\u5fc5\u987b\u662f\u5408\u6cd5\u4eba\u6c11\u5e01\u91d1\u989d",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const quantity = parseNonNegativeSafeInteger(row[headerMap.quantity]);
    if (quantity === null) {
      issues.push(
        buildIssue({
          code: "CARGO_INVALID_TOTAL_QUANTITY",
          message: "\u603b\u5e93\u5b58\u5fc5\u987b\u662f\u975e\u8d1f\u5b89\u5168\u6574\u6570",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const explicitLink = resolveLink(row[headerMap.link]);
    const resolvedLink =
      explicitLink.kind === "valid"
        ? explicitLink.value
        :
      (context.productUrl
        ? { text: context.productUrl.text, url: context.productUrl.url }
        : null);
    if (explicitLink.kind === "valid") {
      context.productUrl = { ...explicitLink.value, rowNumber: sourceRowNumber };
    } else if (context.productUrl) {
      inheritedFrom.productUrl = context.productUrl.rowNumber;
    } else if (explicitLink.kind === "invalid") {
      issues.push({
        code: "CARGO_INVALID_PRODUCT_URL",
        message: "链接文字必须包含合法的绝对 http/https URL",
        severity: "BLOCKING",
        sourceRowNumber,
      });
      continue;
    } else {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_PRODUCT_URL",
          message: "\u94fe\u63a5\u6587\u5b57\u5fc5\u987b\u5305\u542b\u771f\u5b9e URL",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const specificationText = extractDisplayText(row[headerMap.specification]);
    const specification =
      specificationText ||
      (typeof context.specification?.value === "string"
        ? context.specification.value
        : null);
    if (specificationText) {
      context.specification = { rowNumber: sourceRowNumber, value: specificationText };
    } else if (context.specification) {
      inheritedFrom.specification = context.specification.rowNumber;
    }

    const combinationText = extractDisplayText(row[headerMap.combination]);
    const combination =
      combinationText ||
      (typeof context.combination?.value === "string"
        ? context.combination.value
        : null);
    if (combinationText) {
      context.combination = { rowNumber: sourceRowNumber, value: combinationText };
    } else if (context.combination) {
      inheritedFrom.combination = context.combination.rowNumber;
    }

    const explicitWeight = parseWeightGrams(row[headerMap.weight]);
    const weightText = extractDisplayText(row[headerMap.weight]);
    const weightGrams =
      explicitWeight ??
      (weightText.length === 0 && typeof context.weight?.value === "number"
        ? context.weight.value
        : null);
    if (explicitWeight !== null) {
      context.weight = { rowNumber: sourceRowNumber, value: explicitWeight };
    } else if (weightText.length === 0 && context.weight) {
      inheritedFrom.weight = context.weight.rowNumber;
    } else if (weightText.length > 0) {
      issues.push(
        buildIssue({
          code: "CARGO_INVALID_WEIGHT",
          message: "\u91cd\u91cf\u5fc5\u987b\u8f6c\u6362\u4e3a\u975e\u8d1f\u5b89\u5168\u6574\u6570\u514b",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const status = parseSaleStatus(row[headerMap.status]);
    if (status.kind === "missing") {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_SALE_STATUS",
          message: "\u72b6\u6001\u4e0d\u80fd\u4e3a\u7a7a",
          sourceRowNumber,
        }),
      );
      continue;
    }
    if (status.kind === "invalid") {
      issues.push(
        buildIssue({
          code: "CARGO_INVALID_SALE_STATUS",
          message: "\u72b6\u6001\u5fc5\u987b\u662f\u53ef\u552e\u6216\u4e0d\u53ef\u552e",
          sourceRowNumber,
        }),
      );
      continue;
    }
    const parsedSaleStatus = status.value as "SELLABLE" | "NOT_SELLABLE";

    rows.push({
      color: extractDisplayText(row[headerMap.color]) || null,
      combination,
      defaultUnitPriceFen: defaultUnitPriceFen!,
      imageFileToken,
      inheritedFrom,
      linkText: resolvedLink!.text,
      productGroupKey,
      productName,
      productUrl: resolvedLink!.url,
      saleStatus: quantity === 0 ? "NOT_SELLABLE" : parsedSaleStatus,
      skuCode,
      skuName: buildSkuName({
        color: extractDisplayText(row[headerMap.color]) || null,
        combination,
        productName,
        specification,
      }),
      sourceRowNumber,
      specification,
      totalQuantity: quantity,
      weightGrams,
    });
  }

  const { overflowed, summary } = buildSummary(rows);
  if (overflowed) {
    issues.push({
      code: "CARGO_SUMMARY_TOTAL_QUANTITY_OVERFLOW",
      message: "汇总总库存超过安全整数上限",
      severity: "BLOCKING",
    });
  }

  return {
    headerRowNumber: headerRowIndex + 1,
    issues,
    rows,
    summary,
  };
}
