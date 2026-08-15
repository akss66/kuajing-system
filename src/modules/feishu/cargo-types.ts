export type MigrationIssue = {
  code: string;
  message: string;
  severity: "BLOCKING" | "RETRYABLE" | "WARNING";
  sourceRowNumber?: number;
};

export type MigrationSummary = {
  productCount: number;
  sourceSequenceCount: number;
  skuCount: number;
  imageCount: number;
  totalQuantity: number;
};

export type TemporaryAssetManifest = {
  byteSize: number;
  contentSha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  originalFileName: string;
  skuCode: string;
  temporaryKey: string;
};

export type CargoInheritedField =
  | "productGroupKey"
  | "sourceSequence"
  | "productName"
  | "image"
  | "cargoPrice"
  | "price"
  | "productUrl"
  | "specification"
  | "combination"
  | "weight"
  | "saleStatus";

export type NormalizedCargoRow = {
  sourceRowNumber: number;
  productGroupKey: string;
  sourceSequence: string;
  skuCode: string;
  imageContentSha256: string;
  imageTemporaryKey: string;
  productName: string;
  skuName: string;
  defaultUnitPriceFen: number;
  defaultUnitPriceMilliYuan: number;
  cargoUnitPriceMilliYuan: number;
  totalQuantity: number;
  linkText: string;
  productUrl: string | null;
  specification: string | null;
  color: string | null;
  combination: string | null;
  weightGrams: number | null;
  saleStatus: "SELLABLE" | "NOT_SELLABLE";
  inheritedFrom: Partial<Record<CargoInheritedField, number>>;
};

export type ParsedCargoRow = Omit<
  NormalizedCargoRow,
  "imageContentSha256" | "imageTemporaryKey"
> & { imageFileToken: string };

export type CargoPricePlaceholder = {
  skuCode: string;
  unitPriceMilliYuan: number;
};

export type AppliedCargoPricePlaceholder = CargoPricePlaceholder & {
  sourceRowNumber: number;
};

export type CargoParseResult = {
  appliedCargoPricePlaceholders: AppliedCargoPricePlaceholder[];
  headerRowNumber: number;
  rows: ParsedCargoRow[];
  issues: MigrationIssue[];
  summary: MigrationSummary;
};
