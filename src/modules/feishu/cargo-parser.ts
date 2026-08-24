import type {
  AppliedCargoPricePlaceholder,
  CargoInheritedField,
  CargoParseResult,
  CargoPricePlaceholder,
  CargoSyncDegradation,
  CargoSyncParseResult,
  MigrationIssue,
  ParsedCargoSyncRow,
  ParsedCargoRow,
} from "@/modules/feishu/cargo-types";
import { roundMilliYuanToFen } from "@/modules/catalog/unit-price";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const AUDITED_CARGO_PRICE_PLACEHOLDER = {
  skuCode: "TZX-076",
  unitPriceMilliYuan: 99_000,
} as const;
const HEADER_ALIASES = {
  combination: ["\u7ec4\u5408\u9500\u552e"],
  color: ["\u989c\u8272"],
  cargoPrice: ["\u8d27\u54c1\u4ef7\u683c"],
  image: ["\u56fe\u7247"],
  link: ["\u94fe\u63a5\u6587\u5b57"],
  name: ["\u540d\u79f0"],
  price: ["\u91c7\u8d2d\u4ef7"],
  quantity: [
    "\u603b\u5e93\u5b58",
    "\u603b\u5e93\u5b58/\u4ef6",
    "\u603b\u5e93\u5b58(\u4efd)",
  ],
  sequence: ["\u5e8f\u53f7"],
  sku: ["sku"],
  status: ["\u72b6\u6001"],
  specification: ["\u89c4\u683c"],
  weight: ["\u91cd\u91cf"],
} satisfies Record<string, string[]>;

const REQUIRED_HEADER_FIELDS = [
  "sku",
  "name",
  "cargoPrice",
  "price",
  "quantity",
  "status",
] as const satisfies ReadonlyArray<keyof typeof HEADER_ALIASES>;

type HeaderMap = Record<keyof typeof HEADER_ALIASES, number>;

type LinkValue = {
  text: string;
  url: string | null;
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
  cargoPrice: GroupFieldState | null;
  image: GroupFieldState | null;
  price: GroupFieldState | null;
  productGroupKey: GroupFieldState | null;
  productName: GroupFieldState | null;
  productUrl: ({ text: string; url: string | null } & { rowNumber: number }) | null;
  specification: GroupFieldState | null;
  saleStatus: GroupFieldState | null;
  sourceSequence: GroupFieldState | null;
  weight: GroupFieldState | null;
};

function normalizeHeaderCell(value: unknown) {
  return extractDisplayText(value).replace(/\s+/g, "").toLowerCase();
}

function matchesHeader(key: keyof typeof HEADER_ALIASES, value: unknown) {
  const normalized = normalizeHeaderCell(value);
  if (key === "cargoPrice") {
    return (
      normalized === "货品价格" ||
      /^货品价格[（(]/.test(normalized)
    );
  }
  return HEADER_ALIASES[key].includes(normalized);
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

function parseYuanPrice(value: unknown) {
  const text = extractDisplayText(value).replace(/^[\u00a5\uffe5]/, "");
  if (text.length === 0) return null;
  const packageMatch = /^(0\.58\/6PCS|0\.35\/5PCS)$/i.exec(text);
  const amount = packageMatch ? text.slice(0, text.indexOf("/")) : text;
  const unitPriceMilliYuan = parseScaledDecimal(amount, 1_000);
  if (unitPriceMilliYuan === null) return null;
  return {
    packageNotation: packageMatch ? text : null,
    unitPriceFen: roundMilliYuanToFen(unitPriceMilliYuan),
    unitPriceMilliYuan,
  };
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

function parsePackagedCombinationCount(value: string | null) {
  const match = /^(\d+)pcs$/i.exec(value?.replace(/\s+/g, "") ?? "");
  if (!match) return null;

  const count = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function parseWeightGrams(value: unknown, combination: string | null = null) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? { grams: value, normalizedNotation: null }
      : null;
  }

  const raw = extractDisplayText(value);
  if (raw.length === 0) return null;

  const normalized = raw.replace(/\s+/g, "").toLowerCase();
  const perPieceMatch = /^(\d+)g\/pcs$/.exec(normalized);
  if (perPieceMatch) {
    const gramsPerPiece = Number.parseInt(perPieceMatch[1], 10);
    const packageCount = parsePackagedCombinationCount(combination);
    const total = packageCount === null ? null : gramsPerPiece * packageCount;
    return total !== null && Number.isSafeInteger(total) && total >= 0
      ? { grams: total, normalizedNotation: raw }
      : null;
  }
  const packagedMatch = /^(\d+)g\/包$/.exec(normalized);
  if (packagedMatch) {
    const grams = Number.parseInt(packagedMatch[1], 10);
    return Number.isSafeInteger(grams)
      ? { grams, normalizedNotation: raw }
      : null;
  }
  const multipliedMatch = /^(\d+)g\*(\d+)$/.exec(normalized);
  if (multipliedMatch) {
    const grams = Number.parseInt(multipliedMatch[1], 10);
    const count = Number.parseInt(multipliedMatch[2], 10);
    const total = grams * count;
    return Number.isSafeInteger(total) && total >= 0
      ? { grams: total, normalizedNotation: raw }
      : null;
  }
  const match = /^(\d+(?:\.\d+)?)(kg|g|\u514b)$/.exec(normalized);
  if (!match) return null;

  const [, amount, unit] = match;
  if (unit === "kg") {
    const grams = parseScaledDecimal(amount, 1_000);
    return grams === null || grams > MAX_SAFE_INTEGER
      ? null
      : { grams, normalizedNotation: null };
  }
  const decigrams = parseScaledDecimal(amount, 10);
  if (decigrams === null || decigrams > MAX_SAFE_INTEGER) return null;
  const grams = Math.floor((decigrams + 5) / 10);
  return {
    grams,
    normalizedNotation: decigrams % 10 === 0 ? null : raw,
  };
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
  if (text === "0" && collectLinkTargets(value).length === 0) {
    return { kind: "valid", value: { text: "", url: null } };
  }
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
    if (
      REQUIRED_HEADER_FIELDS.every((field) =>
        values[rowIndex].some((cell) => matchesHeader(field, cell)),
      )
    ) {
      return rowIndex;
    }
  }
  return -1;
}

function createHeaderMap(row: unknown[]) {
  const map = {} as HeaderMap;
  for (const key of Object.keys(HEADER_ALIASES) as Array<keyof HeaderMap>) {
    const index = row.findIndex((cell) => matchesHeader(key, cell));
    map[key] = index;
  }
  return map;
}

function isBlankRow(row: unknown[]) {
  return row.every((cell) => extractDisplayText(cell).length === 0);
}

function isStructurallyBlankCell(value: unknown) {
  return (
    extractDisplayText(value).length === 0 &&
    collectFileTokens(value).length === 0 &&
    collectLinkTargets(value).length === 0
  );
}

function isTrailingSkuOnlyDraft(input: {
  headerMap: HeaderMap;
  offset: number;
  row: unknown[];
  values: unknown[][];
}) {
  const remainingRowsAreBlank = input.values
    .slice(input.offset + 1)
    .every((row) => row.every((cell) => isStructurallyBlankCell(cell)));
  if (!remainingRowsAreBlank) return false;

  return input.row.every((cell, index) => {
    if (index === input.headerMap.sequence || index === input.headerMap.sku) {
      return true;
    }
    return isStructurallyBlankCell(cell);
  });
}

function isBlankLinkCell(value: unknown) {
  return (
    extractDisplayText(value).length === 0 &&
    collectLinkTargets(value).length === 0
  );
}

function createEmptyContext(): GroupContext {
  return {
    combination: null,
    cargoPrice: null,
    image: null,
    price: null,
    productGroupKey: null,
    productName: null,
    productUrl: null,
    specification: null,
    saleStatus: null,
    sourceSequence: null,
    weight: null,
  };
}

function resetGroupContext(context: GroupContext) {
  Object.assign(context, createEmptyContext());
}

function normalizeProductGroupKey(value: string) {
  if (!/^\d+$/.test(value)) return value;
  return String(Number.parseInt(value, 10));
}

function deriveTzxProductGroupKey(skuCode: string) {
  const match = /^TZX-(\d+)(?:-|$)/i.exec(skuCode);
  return match ? normalizeProductGroupKey(match[1]) : null;
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
      sourceSequenceCount: new Set(rows.map((row) => row.sourceSequence)).size,
      skuCount: rows.length,
      totalQuantity: overflowed ? 0 : totalQuantity,
    },
  };
}

export function parseLegacyCargoSheet(
  values: unknown[][],
  options: { cargoPricePlaceholders?: readonly CargoPricePlaceholder[] } = {},
): CargoParseResult {
  const headerRowIndex = findHeaderRow(values);
  if (headerRowIndex === -1) {
    return {
      appliedCargoPricePlaceholders: [],
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
        sourceSequenceCount: 0,
        skuCount: 0,
        totalQuantity: 0,
      },
    };
  }

  const headerMap = createHeaderMap(values[headerRowIndex] ?? []);
  const rows: ParsedCargoRow[] = [];
  const appliedCargoPricePlaceholders: AppliedCargoPricePlaceholder[] = [];
  const issues: MigrationIssue[] = collectDuplicateSkuIssues({
    headerMap,
    headerRowIndex,
    values,
  });
  const cargoPricePlaceholdersBySku = new Map<
    string,
    Array<{
      declarationIndex: number;
      isAudited: boolean;
      placeholder: CargoPricePlaceholder;
    }>
  >();
  for (const [declarationIndex, placeholder] of (
    options.cargoPricePlaceholders ?? []
  ).entries()) {
    const isAudited =
      placeholder.skuCode === AUDITED_CARGO_PRICE_PLACEHOLDER.skuCode &&
      placeholder.unitPriceMilliYuan ===
        AUDITED_CARGO_PRICE_PLACEHOLDER.unitPriceMilliYuan;
    if (!isAudited) {
      issues.push({
        code: "CARGO_PRICE_PLACEHOLDER_INVALID",
        message: `SKU ${placeholder.skuCode} 的货品价格占位未获审计批准`,
        severity: "BLOCKING",
      });
    }
    const declarations = cargoPricePlaceholdersBySku.get(placeholder.skuCode) ?? [];
    declarations.push({ declarationIndex, isAudited, placeholder });
    cargoPricePlaceholdersBySku.set(placeholder.skuCode, declarations);
  }
  const appliedCargoPricePlaceholderDeclarationIndexes = new Set<number>();
  const preExistingBlockingIssueRows = new Set(
    issues
      .filter(
        (issue) =>
          issue.severity === "BLOCKING" && issue.sourceRowNumber !== undefined,
      )
      .map((issue) => issue.sourceRowNumber),
  );
  const context = createEmptyContext();

  for (let offset = headerRowIndex + 1; offset < values.length; offset += 1) {
    const row = values[offset] ?? [];
    if (isBlankRow(row)) {
      resetGroupContext(context);
      continue;
    }

    const sourceRowNumber = offset + 1;
    const rowIssueStartIndex = issues.length;
    const inheritedFrom: Partial<Record<CargoInheritedField, number>> = {};
    const rowContext: GroupContext = { ...context };

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

    if (isTrailingSkuOnlyDraft({ headerMap, offset, row, values })) {
      issues.push({
        code: "CARGO_TRAILING_SKU_DRAFT_SKIPPED",
        message: `\u672b\u5c3e SKU ${skuCode} \u4ec5\u6709\u7f16\u53f7\u4e14\u8d44\u6599\u672a\u5b8c\u6210\uff0c\u672c\u6b21\u8fc1\u79fb\u5df2\u8df3\u8fc7`,
        severity: "WARNING",
        sourceRowNumber,
      });
      continue;
    }

    const explicitGroupText = extractDisplayText(row[headerMap.sequence]);
    const explicitSourceSequence = explicitGroupText;
    const explicitGroupKey = explicitGroupText
      ? normalizeProductGroupKey(explicitGroupText)
      : "";
    const previousProductGroupKey =
      typeof rowContext.productGroupKey?.value === "string"
        ? rowContext.productGroupKey.value
        : "";
    const productGroupKey = explicitGroupKey || previousProductGroupKey;
    const sourceSequence =
      explicitSourceSequence ||
      (typeof rowContext.sourceSequence?.value === "string"
        ? rowContext.sourceSequence.value
        : "");

    if (sourceSequence.length === 0) {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_SOURCE_SEQUENCE",
          message: "序号不能为空",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const skuProductGroupKey = deriveTzxProductGroupKey(skuCode);
    if (
      skuProductGroupKey !== null &&
      normalizeProductGroupKey(sourceSequence) !== skuProductGroupKey
    ) {
      issues.push(
        buildIssue({
          code: "CARGO_SEQUENCE_SKU_MISMATCH",
          message: `序号 ${sourceSequence} 与 TZX SKU 商品编号 ${skuProductGroupKey} 不一致`,
          sourceRowNumber,
        }),
      );
      continue;
    }

    if (productGroupKey && previousProductGroupKey !== productGroupKey) {
      resetGroupContext(rowContext);
    }

    if (explicitGroupKey || (!rowContext.productGroupKey && productGroupKey)) {
      rowContext.productGroupKey = { rowNumber: sourceRowNumber, value: productGroupKey };
    } else if (rowContext.productGroupKey) {
      inheritedFrom.productGroupKey = rowContext.productGroupKey.rowNumber;
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

    const explicitProductName = extractDisplayText(row[headerMap.name]);
    const productName =
      explicitProductName ||
      (typeof rowContext.productName?.value === "string"
        ? rowContext.productName.value
        : "");
    if (explicitProductName) {
      rowContext.productName = { rowNumber: sourceRowNumber, value: explicitProductName };
    } else if (rowContext.productName) {
      inheritedFrom.productName = rowContext.productName.rowNumber;
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
      (typeof rowContext.image?.value === "string" ? rowContext.image.value : "");
    if (explicitImageToken) {
      rowContext.image = { rowNumber: sourceRowNumber, value: explicitImageToken };
    } else if (rowContext.image) {
      inheritedFrom.image = rowContext.image.rowNumber;
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

    const explicitPrice = parseYuanPrice(row[headerMap.price]);
    const defaultUnitPriceMilliYuan =
      explicitPrice?.unitPriceMilliYuan ??
      (typeof rowContext.price?.value === "number" ? rowContext.price.value : null);
    if (explicitPrice !== null) {
      rowContext.price = {
        rowNumber: sourceRowNumber,
        value: explicitPrice.unitPriceMilliYuan,
      };
      if (explicitPrice.packageNotation) {
        issues.push({
          code: "CARGO_PACK_PRICE_NORMALIZED",
          message: `${explicitPrice.packageNotation} 按一个整包 SKU 的采购价导入，不按 PCS 拆分单价`,
          severity: "WARNING",
          sourceRowNumber,
        });
      }
    } else if (extractDisplayText(row[headerMap.price]).length === 0 && rowContext.price) {
      inheritedFrom.price = rowContext.price.rowNumber;
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

    if (explicitSourceSequence) {
      rowContext.sourceSequence = {
        rowNumber: sourceRowNumber,
        value: explicitSourceSequence,
      };
    } else if (rowContext.sourceSequence) {
      inheritedFrom.sourceSequence = rowContext.sourceSequence.rowNumber;
    }

    const cargoPriceCell = row[headerMap.cargoPrice];
    const cargoPriceText = extractDisplayText(cargoPriceCell);
    const placeholderDeclarations =
      cargoPricePlaceholdersBySku.get(skuCode) ?? [];
    const explicitCargoPrice = parseYuanPrice(cargoPriceCell);
    if (placeholderDeclarations.length > 0 && explicitCargoPrice !== null) {
      issues.push(
        buildIssue({
          code: "CARGO_PRICE_PLACEHOLDER_NOT_NEEDED",
          message: `SKU ${skuCode} 的货品价格已有来源值，无需占位`,
          sourceRowNumber,
        }),
      );
      continue;
    }

    const placeholder =
      cargoPriceText.length === 0
        ? placeholderDeclarations.find((declaration) => declaration.isAudited)
        : undefined;
    const placeholderCargoPrice = placeholder
      ? {
          unitPriceMilliYuan: placeholder.placeholder.unitPriceMilliYuan,
        }
      : null;
    const cargoUnitPriceMilliYuan =
      explicitCargoPrice?.unitPriceMilliYuan ??
      placeholderCargoPrice?.unitPriceMilliYuan ??
      (typeof rowContext.cargoPrice?.value === "number"
        ? rowContext.cargoPrice.value
        : null);
    if (explicitCargoPrice !== null) {
      rowContext.cargoPrice = {
        rowNumber: sourceRowNumber,
        value: explicitCargoPrice.unitPriceMilliYuan,
      };
    } else if (
      placeholderCargoPrice === null &&
      cargoPriceText.length === 0 &&
      rowContext.cargoPrice
    ) {
      inheritedFrom.cargoPrice = rowContext.cargoPrice.rowNumber;
    } else if (placeholderCargoPrice === null) {
      issues.push(
        buildIssue({
          code: "CARGO_INVALID_CARGO_PRICE",
          message: "货品价格必须是合法人民币金额",
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

    const linkCell = row[headerMap.link];
    const explicitLink = resolveLink(linkCell);
    const resolvedLink =
      explicitLink.kind === "valid"
        ? explicitLink.value
        : isBlankLinkCell(linkCell) && rowContext.productUrl
          ? { text: rowContext.productUrl.text, url: rowContext.productUrl.url }
          : null;
    if (explicitLink.kind === "valid") {
      rowContext.productUrl = { ...explicitLink.value, rowNumber: sourceRowNumber };
      if (explicitLink.value.url === null) {
        issues.push({
          code: "CARGO_PRODUCT_URL_SENTINEL_NORMALIZED",
          message: "链接文字 0 按无商品链接导入",
          severity: "WARNING",
          sourceRowNumber,
        });
      }
    } else if (isBlankLinkCell(linkCell) && rowContext.productUrl) {
      inheritedFrom.productUrl = rowContext.productUrl.rowNumber;
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
      (typeof rowContext.specification?.value === "string"
        ? rowContext.specification.value
        : null);
    if (specificationText) {
      rowContext.specification = { rowNumber: sourceRowNumber, value: specificationText };
    } else if (rowContext.specification) {
      inheritedFrom.specification = rowContext.specification.rowNumber;
    }

    const combinationText = extractDisplayText(row[headerMap.combination]);
    const combination =
      combinationText ||
      (typeof rowContext.combination?.value === "string"
        ? rowContext.combination.value
        : null);
    if (combinationText) {
      rowContext.combination = { rowNumber: sourceRowNumber, value: combinationText };
    } else if (rowContext.combination) {
      inheritedFrom.combination = rowContext.combination.rowNumber;
    }

    const explicitWeight = parseWeightGrams(row[headerMap.weight], combination);
    const weightText = extractDisplayText(row[headerMap.weight]);
    const weightGrams =
      explicitWeight?.grams ??
      (weightText.length === 0 && typeof rowContext.weight?.value === "number"
        ? rowContext.weight.value
        : null);
    if (explicitWeight !== null) {
      rowContext.weight = { rowNumber: sourceRowNumber, value: explicitWeight.grams };
      if (explicitWeight.normalizedNotation) {
        issues.push({
          code: "CARGO_WEIGHT_NOTATION_NORMALIZED",
          message: `${explicitWeight.normalizedNotation} 已按确认规则转换为 ${explicitWeight.grams}g`,
          severity: "WARNING",
          sourceRowNumber,
        });
      }
    } else if (weightText.length === 0 && rowContext.weight) {
      inheritedFrom.weight = rowContext.weight.rowNumber;
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

    const explicitStatus = parseSaleStatus(row[headerMap.status]);
    let parsedSaleStatus: "SELLABLE" | "NOT_SELLABLE" | null = null;
    if (explicitStatus.kind === "value") {
      parsedSaleStatus = explicitStatus.value;
      rowContext.saleStatus = {
        rowNumber: sourceRowNumber,
        value: explicitStatus.value,
      };
    } else if (
      explicitStatus.kind === "missing" &&
      typeof rowContext.saleStatus?.value === "string"
    ) {
      parsedSaleStatus = rowContext.saleStatus.value as "SELLABLE" | "NOT_SELLABLE";
      inheritedFrom.saleStatus = rowContext.saleStatus.rowNumber;
    } else if (explicitStatus.kind === "missing") {
      issues.push(
        buildIssue({
          code: "CARGO_MISSING_SALE_STATUS",
          message: "\u72b6\u6001\u4e0d\u80fd\u4e3a\u7a7a",
          sourceRowNumber,
        }),
      );
      continue;
    } else {
      issues.push(
        buildIssue({
          code: "CARGO_INVALID_SALE_STATUS",
          message: "\u72b6\u6001\u5fc5\u987b\u662f\u53ef\u552e\u6216\u4e0d\u53ef\u552e",
          sourceRowNumber,
        }),
      );
      continue;
    }

    const hasBlockingIssue =
      preExistingBlockingIssueRows.has(sourceRowNumber) ||
      issues
        .slice(rowIssueStartIndex)
        .some((issue) => issue.severity === "BLOCKING");
    if (hasBlockingIssue) {
      continue;
    }

    rows.push({
      color: extractDisplayText(row[headerMap.color]) || null,
      cargoUnitPriceMilliYuan: cargoUnitPriceMilliYuan!,
      combination,
      defaultUnitPriceFen: roundMilliYuanToFen(defaultUnitPriceMilliYuan!),
      defaultUnitPriceMilliYuan: defaultUnitPriceMilliYuan!,
      imageFileToken,
      inheritedFrom,
      linkText: resolvedLink!.text,
      productGroupKey,
      productName,
      productUrl: resolvedLink!.url,
      saleStatus: parsedSaleStatus!,
      skuCode,
      skuName: buildSkuName({
        color: extractDisplayText(row[headerMap.color]) || null,
        combination,
        productName,
        specification,
      }),
      sourceRowNumber,
      sourceSequence,
      specification,
      totalQuantity: quantity,
      weightGrams,
    });
    if (placeholderCargoPrice !== null) {
      appliedCargoPricePlaceholderDeclarationIndexes.add(
        placeholder!.declarationIndex,
      );
      appliedCargoPricePlaceholders.push({
        skuCode,
        sourceRowNumber,
        unitPriceMilliYuan: placeholderCargoPrice.unitPriceMilliYuan,
      });
      issues.push({
        code: "CARGO_PRICE_PLACEHOLDER_APPLIED",
        message: `SKU ${skuCode} 的货品价格已使用审计占位值`,
        severity: "WARNING",
        sourceRowNumber,
      });
    }
    Object.assign(context, rowContext);
  }

  for (const [declarationIndex, placeholder] of (
    options.cargoPricePlaceholders ?? []
  ).entries()) {
    if (!appliedCargoPricePlaceholderDeclarationIndexes.has(declarationIndex)) {
      issues.push({
        code: "CARGO_PRICE_PLACEHOLDER_UNUSED",
        message: `SKU ${placeholder.skuCode} 的货品价格占位未使用`,
        severity: "BLOCKING",
      });
    }
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
    appliedCargoPricePlaceholders,
    headerRowNumber: headerRowIndex + 1,
    issues,
    rows,
    summary,
  };
}

function emptySyncSummary() {
  return {
    imageCount: 0,
    productCount: 0,
    sourceSequenceCount: 0,
    skuCount: 0,
    totalQuantity: 0,
  };
}

function addSyncDegradation(input: {
  code: string;
  field: CargoSyncDegradation["field"];
  issues: MigrationIssue[];
  message: string;
  reasons: CargoSyncDegradation[];
  sourceRowNumber: number;
}) {
  const reason = {
    code: input.code,
    field: input.field,
    message: input.message,
  };
  input.reasons.push(reason);
  input.issues.push({
    code: input.code,
    message: input.message,
    severity: "WARNING",
    sourceRowNumber: input.sourceRowNumber,
  });
}

/**
 * Parses the live cargo sheet without changing the strict legacy-migration
 * contract. A SKU is the only required row identity in this mode. Incomplete
 * rows remain observable as non-sellable drafts with nullable source fields.
 * Mirror mode is stricter because skipping a nonblank row would make its
 * existing system SKU look deleted and trigger destructive reconciliation.
 */
export function parseCargoSheetForSync(
  values: unknown[][],
  options: {
    mode?: "CATALOG_FIELDS_ONLY" | "MIGRATION_MIRROR";
  } = {},
): CargoSyncParseResult {
  const headerRowIndex = findHeaderRow(values);
  if (headerRowIndex === -1) {
    const issues: MigrationIssue[] = [
      {
        code: "CARGO_HEADER_NOT_FOUND",
        message: "未找到旧飞书货盘表头",
        severity: "BLOCKING",
      },
    ];
    return {
      headerRowNumber: 0,
      issues,
      rows: [],
      summary: emptySyncSummary(),
      warnings: [],
    };
  }

  const headerMap = createHeaderMap(values[headerRowIndex] ?? []);
  const rows: ParsedCargoSyncRow[] = [];
  const issues = collectDuplicateSkuIssues({
    headerMap,
    headerRowIndex,
    values,
  });
  const context = createEmptyContext();

  for (let offset = headerRowIndex + 1; offset < values.length; offset += 1) {
    const row = values[offset] ?? [];
    if (isBlankRow(row)) {
      resetGroupContext(context);
      continue;
    }

    const sourceRowNumber = offset + 1;
    const skuCode = extractDisplayText(row[headerMap.sku]);
    if (!skuCode) {
      const isMigrationMirror = options.mode === "MIGRATION_MIRROR";
      issues.push({
        code: isMigrationMirror
          ? "CARGO_SYNC_MISSING_SKU_BLOCKING"
          : "CARGO_SYNC_MISSING_SKU_SKIPPED",
        message: isMigrationMirror
          ? `第 ${sourceRowNumber} 行存在货盘内容但缺少 SKU，镜像同步已阻止`
          : `第 ${sourceRowNumber} 行没有 SKU，已按残留或草稿行跳过`,
        severity: isMigrationMirror ? "BLOCKING" : "WARNING",
        sourceRowNumber,
      });
      continue;
    }

    const degradedReasons: CargoSyncDegradation[] = [];
    const inheritedFrom: Partial<Record<CargoInheritedField, number>> = {};
    const rowContext: GroupContext = { ...context };
    const explicitSequence = extractDisplayText(row[headerMap.sequence]);
    const derivedSequence = deriveTzxProductGroupKey(skuCode);
    const previousSequence =
      typeof rowContext.sourceSequence?.value === "string"
        ? rowContext.sourceSequence.value
        : null;

    if (
      explicitSequence &&
      derivedSequence !== null &&
      normalizeProductGroupKey(explicitSequence) !== derivedSequence
    ) {
      issues.push(
        buildIssue({
          code: "CARGO_SEQUENCE_SKU_MISMATCH",
          message: `序号 ${explicitSequence} 与 TZX SKU 商品编号 ${derivedSequence} 不一致`,
          sourceRowNumber,
        }),
      );
      continue;
    }

    let sourceSequence: string | null = null;
    if (explicitSequence) {
      sourceSequence = explicitSequence;
    } else if (
      previousSequence &&
      (derivedSequence === null ||
        normalizeProductGroupKey(previousSequence) === derivedSequence)
    ) {
      sourceSequence = previousSequence;
      inheritedFrom.sourceSequence = rowContext.sourceSequence!.rowNumber;
    } else if (derivedSequence !== null) {
      sourceSequence = derivedSequence;
      addSyncDegradation({
        code: "CARGO_SYNC_SEQUENCE_DERIVED",
        field: "sourceSequence",
        issues,
        message: `序号为空，已从 SKU ${skuCode} 推导为 ${derivedSequence}`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    } else {
      addSyncDegradation({
        code: "CARGO_SYNC_MISSING_SOURCE_SEQUENCE",
        field: "sourceSequence",
        issues,
        message: `SKU ${skuCode} 缺少序号，且无法从 SKU 推导`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const productGroupKey = sourceSequence
      ? normalizeProductGroupKey(sourceSequence)
      : skuCode;
    const previousProductGroupKey =
      typeof rowContext.productGroupKey?.value === "string"
        ? rowContext.productGroupKey.value
        : null;
    if (previousProductGroupKey !== productGroupKey) {
      resetGroupContext(rowContext);
    }
    if (explicitSequence || previousProductGroupKey !== productGroupKey) {
      rowContext.productGroupKey = {
        rowNumber: sourceRowNumber,
        value: productGroupKey,
      };
      if (sourceSequence !== null) {
        rowContext.sourceSequence = {
          rowNumber: sourceRowNumber,
          value: sourceSequence,
        };
      }
    } else if (rowContext.productGroupKey) {
      inheritedFrom.productGroupKey = rowContext.productGroupKey.rowNumber;
    }

    const explicitProductName = extractDisplayText(row[headerMap.name]);
    let productName = explicitProductName;
    if (explicitProductName) {
      rowContext.productName = {
        rowNumber: sourceRowNumber,
        value: explicitProductName,
      };
    } else if (typeof rowContext.productName?.value === "string") {
      productName = rowContext.productName.value;
      inheritedFrom.productName = rowContext.productName.rowNumber;
    } else {
      productName = skuCode;
      addSyncDegradation({
        code: "CARGO_SYNC_PRODUCT_NAME_FALLBACK",
        field: "productName",
        issues,
        message: `SKU ${skuCode} 缺少名称，已使用 SKU 作为草稿显示名`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const imageCell = row[headerMap.image];
    const explicitImageToken = resolveImageToken(imageCell);
    let imageFileToken: string | null = explicitImageToken;
    if (explicitImageToken) {
      rowContext.image = {
        rowNumber: sourceRowNumber,
        value: explicitImageToken,
      };
    } else if (isStructurallyBlankCell(imageCell) && rowContext.image) {
      imageFileToken = rowContext.image.value as string;
      inheritedFrom.image = rowContext.image.rowNumber;
    } else {
      addSyncDegradation({
        code: isStructurallyBlankCell(imageCell)
          ? "CARGO_SYNC_MISSING_IMAGE"
          : "CARGO_SYNC_INVALID_IMAGE",
        field: "imageFileToken",
        issues,
        message: `SKU ${skuCode} 的图片缺失或不是唯一 fileToken`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const priceCell = row[headerMap.price];
    const explicitPrice = parseYuanPrice(priceCell);
    let defaultUnitPriceMilliYuan: number | null =
      explicitPrice?.unitPriceMilliYuan ?? null;
    if (explicitPrice) {
      rowContext.price = {
        rowNumber: sourceRowNumber,
        value: explicitPrice.unitPriceMilliYuan,
      };
      if (explicitPrice.packageNotation) {
        issues.push({
          code: "CARGO_PACK_PRICE_NORMALIZED",
          message: `${explicitPrice.packageNotation} 按一个整包 SKU 的采购价导入，不按 PCS 拆分单价`,
          severity: "WARNING",
          sourceRowNumber,
        });
      }
    } else if (!extractDisplayText(priceCell) && rowContext.price) {
      defaultUnitPriceMilliYuan = rowContext.price.value as number;
      inheritedFrom.price = rowContext.price.rowNumber;
    } else {
      addSyncDegradation({
        code: extractDisplayText(priceCell)
          ? "CARGO_SYNC_INVALID_PRICE"
          : "CARGO_SYNC_MISSING_PRICE",
        field: "defaultUnitPriceMilliYuan",
        issues,
        message: `SKU ${skuCode} 的采购价缺失或格式无效`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const cargoPriceCell = row[headerMap.cargoPrice];
    const explicitCargoPrice = parseYuanPrice(cargoPriceCell);
    let cargoUnitPriceMilliYuan: number | null =
      explicitCargoPrice?.unitPriceMilliYuan ?? null;
    if (explicitCargoPrice) {
      rowContext.cargoPrice = {
        rowNumber: sourceRowNumber,
        value: explicitCargoPrice.unitPriceMilliYuan,
      };
    } else if (!extractDisplayText(cargoPriceCell) && rowContext.cargoPrice) {
      cargoUnitPriceMilliYuan = rowContext.cargoPrice.value as number;
      inheritedFrom.cargoPrice = rowContext.cargoPrice.rowNumber;
    } else {
      addSyncDegradation({
        code: extractDisplayText(cargoPriceCell)
          ? "CARGO_SYNC_INVALID_CARGO_PRICE"
          : "CARGO_SYNC_MISSING_CARGO_PRICE",
        field: "cargoUnitPriceMilliYuan",
        issues,
        message: `SKU ${skuCode} 的货品价格缺失或格式无效`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const quantityCell = row[headerMap.quantity];
    const totalQuantity = parseNonNegativeSafeInteger(quantityCell);
    if (totalQuantity === null) {
      addSyncDegradation({
        code: extractDisplayText(quantityCell)
          ? "CARGO_SYNC_INVALID_TOTAL_QUANTITY"
          : "CARGO_SYNC_MISSING_TOTAL_QUANTITY",
        field: "totalQuantity",
        issues,
        message: `SKU ${skuCode} 的总库存缺失或不是非负安全整数`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const linkCell = row[headerMap.link];
    const explicitLink = resolveLink(linkCell);
    let resolvedLink: LinkValue | null = null;
    if (explicitLink.kind === "valid" && explicitLink.value.url !== null) {
      resolvedLink = explicitLink.value;
      rowContext.productUrl = {
        ...explicitLink.value,
        rowNumber: sourceRowNumber,
      };
    } else if (isBlankLinkCell(linkCell) && rowContext.productUrl) {
      resolvedLink = {
        text: rowContext.productUrl.text,
        url: rowContext.productUrl.url,
      };
      inheritedFrom.productUrl = rowContext.productUrl.rowNumber;
    } else {
      addSyncDegradation({
        code:
          explicitLink.kind === "invalid"
            ? "CARGO_SYNC_INVALID_PRODUCT_URL"
            : "CARGO_SYNC_MISSING_PRODUCT_URL",
        field: "productUrl",
        issues,
        message: `SKU ${skuCode} 的商品链接缺失或不是合法 http/https URL`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const specificationText = extractDisplayText(row[headerMap.specification]);
    let specification: string | null = specificationText || null;
    if (specificationText) {
      rowContext.specification = {
        rowNumber: sourceRowNumber,
        value: specificationText,
      };
    } else if (typeof rowContext.specification?.value === "string") {
      specification = rowContext.specification.value;
      inheritedFrom.specification = rowContext.specification.rowNumber;
    } else {
      addSyncDegradation({
        code: "CARGO_SYNC_MISSING_SPECIFICATION",
        field: "specification",
        issues,
        message: `SKU ${skuCode} 缺少规格`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const combinationText = extractDisplayText(row[headerMap.combination]);
    let combination: string | null = combinationText || null;
    if (combinationText) {
      rowContext.combination = {
        rowNumber: sourceRowNumber,
        value: combinationText,
      };
    } else if (typeof rowContext.combination?.value === "string") {
      combination = rowContext.combination.value;
      inheritedFrom.combination = rowContext.combination.rowNumber;
    }

    const weightCell = row[headerMap.weight];
    const weightText = extractDisplayText(weightCell);
    const explicitWeight = parseWeightGrams(weightCell, combination);
    let weightGrams: number | null = explicitWeight?.grams ?? null;
    if (explicitWeight) {
      rowContext.weight = {
        rowNumber: sourceRowNumber,
        value: explicitWeight.grams,
      };
      if (explicitWeight.normalizedNotation) {
        issues.push({
          code: "CARGO_WEIGHT_NOTATION_NORMALIZED",
          message: `${explicitWeight.normalizedNotation} 已按确认规则转换为 ${explicitWeight.grams}g`,
          severity: "WARNING",
          sourceRowNumber,
        });
      }
    } else if (!weightText && rowContext.weight) {
      weightGrams = rowContext.weight.value as number;
      inheritedFrom.weight = rowContext.weight.rowNumber;
    } else {
      addSyncDegradation({
        code: weightText
          ? "CARGO_SYNC_INVALID_WEIGHT"
          : "CARGO_SYNC_MISSING_WEIGHT",
        field: "weightGrams",
        issues,
        message: `SKU ${skuCode} 的重量缺失或格式无效`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const explicitStatus = parseSaleStatus(row[headerMap.status]);
    let sourceSaleStatus: "SELLABLE" | "NOT_SELLABLE" = "NOT_SELLABLE";
    if (explicitStatus.kind === "value") {
      sourceSaleStatus = explicitStatus.value;
      rowContext.saleStatus = {
        rowNumber: sourceRowNumber,
        value: explicitStatus.value,
      };
    } else if (
      explicitStatus.kind === "missing" &&
      typeof rowContext.saleStatus?.value === "string"
    ) {
      sourceSaleStatus = rowContext.saleStatus.value as
        | "SELLABLE"
        | "NOT_SELLABLE";
      inheritedFrom.saleStatus = rowContext.saleStatus.rowNumber;
    } else {
      addSyncDegradation({
        code:
          explicitStatus.kind === "invalid"
            ? "CARGO_SYNC_INVALID_SALE_STATUS"
            : "CARGO_SYNC_MISSING_SALE_STATUS",
        field: "saleStatus",
        issues,
        message: `SKU ${skuCode} 的状态缺失或不是可售/不可售`,
        reasons: degradedReasons,
        sourceRowNumber,
      });
    }

    const color = extractDisplayText(row[headerMap.color]) || null;
    rows.push({
      cargoUnitPriceMilliYuan,
      color,
      combination,
      defaultUnitPriceFen:
        defaultUnitPriceMilliYuan === null
          ? null
          : roundMilliYuanToFen(defaultUnitPriceMilliYuan),
      defaultUnitPriceMilliYuan,
      degradedReasons,
      imageFileToken,
      inheritedFrom,
      linkText: resolvedLink?.text || null,
      productGroupKey,
      productName,
      productUrl: resolvedLink?.url ?? null,
      saleStatus:
        degradedReasons.length > 0 ? "NOT_SELLABLE" : sourceSaleStatus,
      skuCode,
      skuName: buildSkuName({
        color,
        combination,
        productName,
        specification,
      }),
      sourceRowNumber,
      sourceSequence,
      specification,
      totalQuantity,
      weightGrams,
    });
    Object.assign(context, rowContext);
  }

  let totalQuantity = 0;
  let overflowed = false;
  for (const row of rows) {
    if (row.totalQuantity === null) continue;
    if (row.totalQuantity > MAX_SAFE_INTEGER - totalQuantity) {
      overflowed = true;
      break;
    }
    totalQuantity += row.totalQuantity;
  }
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
    summary: {
      imageCount: rows.filter((row) => row.imageFileToken !== null).length,
      productCount: new Set(rows.map((row) => row.productGroupKey)).size,
      sourceSequenceCount: new Set(
        rows
          .map((row) => row.sourceSequence)
          .filter((value): value is string => value !== null),
      ).size,
      skuCount: rows.length,
      totalQuantity: overflowed ? 0 : totalQuantity,
    },
    warnings: issues.filter((issue) => issue.severity === "WARNING"),
  };
}
