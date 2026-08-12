import ExcelJS from "exceljs";

export const TEMU_EXPORT_HEADERS = [
  "订单号",
  "站点",
  "订单状态",
  "子订单号",
  "应履约件数",
  "商品名称",
  "SKUID",
  "SKCID",
  "SPUID",
  "SKU货号",
  "商品属性",
  "收货人姓名",
  "收货人联系方式",
  "备用联系方式",
  "邮箱",
  "身份证号",
  "税号",
  "详细地址1",
  "详细地址2",
  "详细地址3",
  "区县",
  "城市",
  "省份",
  "收货地址邮编",
  "国家",
  "运单号",
  "物流商",
  "发货仓",
  "订单创建时间",
  "要求最晚发货时间",
  "实际发货时间",
  "预计送达时间",
  "实际签收时间",
] as const;

export const TEMU_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const TEMU_MAX_DATA_ROWS = 50_000;
export const TEMU_XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type TemuHeader = (typeof TEMU_EXPORT_HEADERS)[number];
type ImportRowStatus = "READY" | "DUPLICATE" | "UNKNOWN_SKU";

export type TemuRecipient = {
  name: string;
  phone: string;
  alternatePhone: string | null;
  email: string | null;
  identityNumber: string | null;
  taxNumber: string | null;
  addressLine1: string;
  addressLine2: string | null;
  addressLine3: string | null;
  district: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
};

export type ParsedTemuRow = {
  rowNumber: number;
  externalOrderNo: string;
  externalSubOrderNo: string;
  externalSku: string;
  quantity: number;
  productName: string;
  productAttributes: string | null;
  recipient: TemuRecipient;
};

export type TemuParseIssueCode =
  | "MISSING_ORDER_NUMBER"
  | "MISSING_SUB_ORDER_NUMBER"
  | "MISSING_EXTERNAL_SKU"
  | "INVALID_QUANTITY"
  | "INVALID_RECIPIENT"
  | "INVALID_CANADA_ADDRESS";

export type TemuParseIssue = {
  rowNumber: number;
  code: TemuParseIssueCode;
  message: string;
};

export type TemuParseResult = {
  rows: ParsedTemuRow[];
  issues: TemuParseIssue[];
};

export type ClassifiedTemuRow = ParsedTemuRow & {
  status: ImportRowStatus;
  resolvedSkuId: string | null;
};

export type ClassifiedTemuResult = {
  rows: ClassifiedTemuRow[];
  issues: TemuParseIssue[];
  summary: {
    total: number;
    ready: number;
    duplicate: number;
    unknownSku: number;
    invalid: number;
  };
};

export type TemuShipmentGroup = {
  externalOrderNo: string;
  recipient: TemuRecipient;
  rows: ParsedTemuRow[];
};

export type TemuWorkbookErrorCode =
  | "INVALID_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "INVALID_WORKBOOK"
  | "INVALID_HEADERS"
  | "TOO_MANY_ROWS"
  | "EMPTY_WORKBOOK";

export class TemuWorkbookError extends Error {
  constructor(
    public readonly code: TemuWorkbookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemuWorkbookError";
  }
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("").trim();
  }
  if ("result" in value) {
    return cellText(value.result ?? null);
  }
  if ("text" in value) {
    return String(value.text).trim();
  }

  return "";
}

function optional(value: string) {
  return value === "" ? null : value;
}

function readRow(
  worksheetRow: ExcelJS.Row,
): Record<TemuHeader, string> {
  return Object.fromEntries(
    TEMU_EXPORT_HEADERS.map((header, index) => [
      header,
      cellText(worksheetRow.getCell(index + 1).value),
    ]),
  ) as Record<TemuHeader, string>;
}

function isCanada(country: string) {
  return ["ca", "canada", "加拿大"].includes(country.trim().toLowerCase());
}

function invalid(
  rowNumber: number,
  code: TemuParseIssueCode,
  message: string,
): TemuParseIssue {
  return { rowNumber, code, message };
}

function parseDataRow(
  raw: Record<TemuHeader, string>,
  rowNumber: number,
): ParsedTemuRow | TemuParseIssue {
  if (!raw.订单号) {
    return invalid(rowNumber, "MISSING_ORDER_NUMBER", `第 ${rowNumber} 行缺少订单号`);
  }
  if (!raw.子订单号) {
    return invalid(
      rowNumber,
      "MISSING_SUB_ORDER_NUMBER",
      `第 ${rowNumber} 行缺少子订单号`,
    );
  }
  if (!raw.SKU货号) {
    return invalid(rowNumber, "MISSING_EXTERNAL_SKU", `第 ${rowNumber} 行缺少 SKU 货号`);
  }

  const quantity = Number(raw.应履约件数);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    return invalid(
      rowNumber,
      "INVALID_QUANTITY",
      `第 ${rowNumber} 行的应履约件数必须是正整数`,
    );
  }

  if (!raw.收货人姓名 || !raw.收货人联系方式) {
    return invalid(
      rowNumber,
      "INVALID_RECIPIENT",
      `第 ${rowNumber} 行的收件人信息不完整`,
    );
  }

  if (
    !raw.详细地址1 ||
    !raw.城市 ||
    !raw.省份 ||
    !raw.收货地址邮编 ||
    !isCanada(raw.国家)
  ) {
    return invalid(
      rowNumber,
      "INVALID_CANADA_ADDRESS",
      `第 ${rowNumber} 行的加拿大收货地址不完整`,
    );
  }

  return {
    rowNumber,
    externalOrderNo: raw.订单号,
    externalSubOrderNo: raw.子订单号,
    externalSku: raw.SKU货号,
    quantity,
    productName: raw.商品名称,
    productAttributes: optional(raw.商品属性),
    recipient: {
      name: raw.收货人姓名,
      phone: raw.收货人联系方式,
      alternatePhone: optional(raw.备用联系方式),
      email: optional(raw.邮箱),
      identityNumber: optional(raw.身份证号),
      taxNumber: optional(raw.税号),
      addressLine1: raw.详细地址1,
      addressLine2: optional(raw.详细地址2),
      addressLine3: optional(raw.详细地址3),
      district: optional(raw.区县),
      city: raw.城市,
      province: raw.省份,
      postalCode: raw.收货地址邮编,
      country: raw.国家,
    },
  };
}

export async function parseTemuOrderWorkbook(input: {
  buffer: Uint8Array;
  fileName: string;
  mimeType?: string;
}): Promise<TemuParseResult> {
  if (
    !input.fileName.toLowerCase().endsWith(".xlsx") ||
    (input.mimeType !== undefined && input.mimeType !== TEMU_XLSX_MIME_TYPE)
  ) {
    throw new TemuWorkbookError(
      "INVALID_FILE_TYPE",
      "仅支持 TEMU 导出的 .xlsx 文件",
    );
  }
  if (input.buffer.byteLength > TEMU_MAX_FILE_BYTES) {
    throw new TemuWorkbookError(
      "FILE_TOO_LARGE",
      "文件不能超过 10 MB",
    );
  }

  const workbook = new ExcelJS.Workbook();
  try {
    const workbookBuffer = new Uint8Array(input.buffer).buffer as ArrayBuffer;
    await workbook.xlsx.load(workbookBuffer);
  } catch {
    throw new TemuWorkbookError(
      "INVALID_WORKBOOK",
      "无法读取 Excel 文件，请重新从 TEMU 后台导出",
    );
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new TemuWorkbookError("EMPTY_WORKBOOK", "Excel 文件中没有工作表");
  }

  const actualHeaders = Array.from(
    { length: Math.max(worksheet.actualColumnCount, TEMU_EXPORT_HEADERS.length) },
    (_, index) => cellText(worksheet.getRow(1).getCell(index + 1).value),
  );
  if (
    actualHeaders.length !== TEMU_EXPORT_HEADERS.length ||
    actualHeaders.some((header, index) => header !== TEMU_EXPORT_HEADERS[index])
  ) {
    throw new TemuWorkbookError(
      "INVALID_HEADERS",
      "Excel 表头与 TEMU 订单导出模板不一致",
    );
  }

  const dataRowCount = Math.max(worksheet.actualRowCount - 1, 0);
  if (dataRowCount > TEMU_MAX_DATA_ROWS) {
    throw new TemuWorkbookError(
      "TOO_MANY_ROWS",
      `单次最多导入 ${TEMU_MAX_DATA_ROWS} 行订单`,
    );
  }

  const rows: ParsedTemuRow[] = [];
  const issues: TemuParseIssue[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    const worksheetRow = worksheet.getRow(rowNumber);
    const raw = readRow(worksheetRow);
    if (Object.values(raw).every((value) => value === "")) {
      continue;
    }

    const result = parseDataRow(raw, rowNumber);
    if ("code" in result) {
      issues.push(result);
    } else {
      rows.push(result);
    }
  }

  return { rows, issues };
}

export function classifyTemuRows(
  parsed: TemuParseResult,
  input: {
    duplicateSubOrderNumbers: ReadonlySet<string>;
    skuIdByExactAlias: ReadonlyMap<string, string>;
  },
): ClassifiedTemuResult {
  const rows = parsed.rows.map<ClassifiedTemuRow>((row) => {
    if (input.duplicateSubOrderNumbers.has(row.externalSubOrderNo)) {
      return { ...row, status: "DUPLICATE", resolvedSkuId: null };
    }

    const resolvedSkuId = input.skuIdByExactAlias.get(row.externalSku) ?? null;
    return {
      ...row,
      status: resolvedSkuId ? "READY" : "UNKNOWN_SKU",
      resolvedSkuId,
    };
  });

  return {
    rows,
    issues: parsed.issues,
    summary: {
      total: rows.length + parsed.issues.length,
      ready: rows.filter((row) => row.status === "READY").length,
      duplicate: rows.filter((row) => row.status === "DUPLICATE").length,
      unknownSku: rows.filter((row) => row.status === "UNKNOWN_SKU").length,
      invalid: parsed.issues.length,
    },
  };
}

export function groupTemuRowsIntoShipments(
  rows: readonly ParsedTemuRow[],
): TemuShipmentGroup[] {
  const groups = new Map<string, TemuShipmentGroup>();

  for (const row of rows) {
    const existing = groups.get(row.externalOrderNo);
    if (existing) {
      existing.rows.push(row);
      continue;
    }

    groups.set(row.externalOrderNo, {
      externalOrderNo: row.externalOrderNo,
      recipient: row.recipient,
      rows: [row],
    });
  }

  return [...groups.values()];
}
