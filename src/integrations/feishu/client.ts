import { z } from "zod";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;

const baseResponseSchema = z.object({
  code: z.coerce.number().int(),
  data: z.unknown().optional(),
  msg: z.string().optional().default(""),
});

const tokenResponseSchema = z.object({
  code: z.coerce.number().int(),
  expire: z.coerce.number().int().positive(),
  tenant_access_token: z.string().min(1),
});

const wikiResponseSchema = baseResponseSchema.extend({
  data: z
    .object({
      node: z.object({
        obj_token: z.string().min(1),
        obj_type: z.string().min(1),
      }),
    })
    .optional(),
});

const sheetsResponseSchema = baseResponseSchema.extend({
  data: z
    .object({
      sheets: z.array(
        z.object({
          index: z.coerce.number().int().nonnegative(),
          sheet_id: z.string().min(1),
          title: z.string(),
        }),
      ),
    })
    .optional(),
});

const rangeResponseSchema = baseResponseSchema.extend({
  data: z
    .object({
      revision: z.coerce.number().int().nonnegative().optional(),
      valueRange: z
        .object({
          range: z.string().optional(),
          revision: z.coerce.number().int().nonnegative().optional(),
          values: z.array(z.array(z.unknown())).optional().default([]),
        })
        .optional(),
    })
    .optional(),
});

export type FeishuRangeResult = {
  revision: number;
  range: string;
  values: unknown[][];
};

export type FeishuStyleBatchUpdate = Array<{
  ranges: string[];
  style: Record<string, unknown>;
}>;

export type FeishuDimensionInput = {
  sheetId: string;
  majorDimension: "ROWS" | "COLUMNS";
  startIndex: number;
  endIndex: number;
};

export type FeishuDimensionProperties = {
  visible?: boolean;
  fixedSize?: number;
};

export type FeishuFilterCondition = {
  filter_type: string;
  compare_type?: string;
  expected?: string[];
};

export class FeishuApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

function errorMessage(code: number) {
  if (code === 1310213 || code === 131006) {
    return "Feishu document permission is missing";
  }
  return `Feishu API returned error code ${code}`;
}

function sanitizeSuggestedFileName(fileName: string | null) {
  if (!fileName) return null;
  const stripped = fileName.split(/[\\/]/).pop()?.trim() ?? "";
  const cleaned = stripped.replace(/[\u0000-\u001F\u007F]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function parseSuggestedFileName(contentDisposition: string | null) {
  if (!contentDisposition) return null;

  const encodedMatch = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition);
  if (encodedMatch) {
    try {
      return sanitizeSuggestedFileName(decodeURIComponent(encodedMatch[1]));
    } catch {
      return sanitizeSuggestedFileName(encodedMatch[1]);
    }
  }

  const quotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(contentDisposition);
  if (quotedMatch) {
    return sanitizeSuggestedFileName(quotedMatch[1]);
  }

  const unquotedMatch = /filename\s*=\s*([^;]+)/i.exec(contentDisposition);
  return sanitizeSuggestedFileName(unquotedMatch?.[1]?.trim() ?? null);
}

export class FeishuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { expiresAt: number; value: string } | null = null;

  constructor(input: {
    appId: string;
    appSecret: string;
    baseUrl?: string;
    fetch?: FetchLike;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.appId = input.appId;
    this.appSecret = input.appSecret;
    this.baseUrl = (input.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
    this.fetcher = input.fetch ?? fetch;
    this.now = input.now ?? Date.now;
    this.timeoutMs = input.timeoutMs ?? 15_000;
  }

  async resolveWikiSpreadsheet(wikiToken: string) {
    const url = new URL("/open-apis/wiki/v2/spaces/get_node", this.baseUrl);
    url.searchParams.set("token", wikiToken);
    const response = wikiResponseSchema.safeParse(await this.authorizedJson(url));
    if (!response.success || response.data.code !== 0 || !response.data.data) {
      this.throwResponseError(response);
    }
    if (response.data.data.node.obj_type !== "sheet") {
      throw new FeishuApiError(
        "WIKI_NODE_NOT_SHEET",
        "Feishu wiki node is not a sheet",
        false,
      );
    }
    return { spreadsheetToken: response.data.data.node.obj_token };
  }

  async listSheets(spreadsheetToken: string) {
    const response = sheetsResponseSchema.safeParse(
      await this.authorizedJson(
        `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
      ),
    );
    if (!response.success || response.data.code !== 0 || !response.data.data) {
      this.throwResponseError(response);
    }
    return response.data.data.sheets.map((sheet) => ({
      index: sheet.index,
      sheetId: sheet.sheet_id,
      title: sheet.title,
    }));
  }

  async writeRange(input: {
    range: string;
    spreadsheetToken: string;
    values: Array<Array<number | string | null>>;
  }) {
    return this.expectSuccess(
      await this.authorizedJson(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values`,
        {
          body: JSON.stringify({
            valueRange: { range: input.range, values: input.values },
          }),
          method: "PUT",
        },
      ),
    );
  }

  async readRangeDetails(input: {
    range: string;
    spreadsheetToken: string;
  }): Promise<FeishuRangeResult> {
    const response = rangeResponseSchema.safeParse(
      await this.authorizedJson(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(input.range)}`,
      ),
    );
    if (!response.success || response.data.code !== 0 || !response.data.data) {
      this.throwResponseError(response);
    }

    const valueRange = response.data.data.valueRange;
    return {
      range: valueRange?.range ?? input.range,
      revision: valueRange?.revision ?? response.data.data.revision ?? 0,
      values: valueRange?.values ?? [],
    };
  }

  async readRange(input: { range: string; spreadsheetToken: string }) {
    return (await this.readRangeDetails(input)).values;
  }

  async downloadMedia(fileToken: string): Promise<{
    bytes: Uint8Array;
    contentType: string;
    fileName: string | null;
  }> {
    const response = await this.authorizedResponse(
      `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
    );
    const declaredLength = Number.parseInt(
      response.headers.get("Content-Length") ?? "",
      10,
    );
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_IMAGE_BYTES) {
      throw new FeishuApiError(
        "MEDIA_TOO_LARGE",
        "Feishu media exceeds the 8 MiB download limit",
        false,
      );
    }

    return {
      bytes: await this.readBinaryBody(response),
      contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
      fileName: parseSuggestedFileName(
        response.headers.get("Content-Disposition"),
      ),
    };
  }

  async writeImage(input: {
    spreadsheetToken: string;
    range: string;
    bytes: Uint8Array;
    fileName: string;
  }) {
    return this.expectSuccess(
      await this.authorizedJson(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values_image`,
        {
          body: JSON.stringify({
            image: Array.from(input.bytes),
            name: input.fileName,
            range: input.range,
          }),
          method: "POST",
        },
      ),
    );
  }

  async setRangeStyle(input: {
    spreadsheetToken: string;
    data: FeishuStyleBatchUpdate;
  }) {
    return this.expectSuccess(
      await this.authorizedJson(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/styles_batch_update`,
        {
          body: JSON.stringify({ data: input.data }),
          method: "PUT",
        },
      ),
    );
  }

  async updateDimension(input: {
    spreadsheetToken: string;
    dimension: FeishuDimensionInput;
    dimensionProperties: FeishuDimensionProperties;
  }) {
    return this.expectSuccess(
      await this.authorizedJson(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/dimension_range`,
        {
          body: JSON.stringify({
            dimension: input.dimension,
            dimensionProperties: input.dimensionProperties,
          }),
          method: "PUT",
        },
      ),
    );
  }

  async createFilter(input: {
    spreadsheetToken: string;
    sheetId: string;
    range: string;
    col: string;
    condition: FeishuFilterCondition;
  }) {
    return this.expectSuccess(
      await this.authorizedJson(
        `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/sheets/${encodeURIComponent(input.sheetId)}/filter`,
        {
          body: JSON.stringify({
            col: input.col,
            condition: input.condition,
            range: input.range,
          }),
          method: "POST",
        },
      ),
    );
  }

  async sendTextMessage(input: { chatId: string; text: string }) {
    return this.expectSuccess(
      await this.authorizedJson(
        "/open-apis/im/v1/messages?receive_id_type=chat_id",
        {
          body: JSON.stringify({
            content: JSON.stringify({ text: input.text }),
            msg_type: "text",
            receive_id: input.chatId,
          }),
          method: "POST",
        },
      ),
    );
  }

  private expectSuccess(value: unknown) {
    const response = baseResponseSchema.safeParse(value);
    if (!response.success || response.data.code !== 0) {
      this.throwResponseError(response);
    }
    return response.data.data;
  }

  private throwResponseError(
    response:
      | { success: false }
      | { success: true; data: { code: number; msg?: string } },
  ): never {
    if (!response.success) {
      throw new FeishuApiError(
        "INVALID_RESPONSE",
        "Feishu API returned an invalid response",
        true,
      );
    }
    const code = response.data.code;
    throw new FeishuApiError(
      String(code),
      errorMessage(code),
      code >= 99990000 || code === 1315201 || code === 1315203,
    );
  }

  private async authorizedJson(path: string | URL, init: RequestInit = {}) {
    const response = await this.authorizedResponse(path, {
      ...init,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...init.headers,
      },
    });
    return this.parseJson(response);
  }

  private async authorizedResponse(path: string | URL, init: RequestInit = {}) {
    const token = await this.tenantToken();
    return this.fetchResponse(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  }

  private async tenantToken() {
    if (this.token && this.token.expiresAt - 5 * 60_000 > this.now()) {
      return this.token.value;
    }
    const response = tokenResponseSchema.safeParse(
      await this.parseJson(
        await this.fetchResponse("/open-apis/auth/v3/tenant_access_token/internal", {
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
          headers: { "Content-Type": "application/json; charset=utf-8" },
          method: "POST",
        }),
      ),
    );
    if (!response.success || response.data.code !== 0) {
      throw new FeishuApiError(
        response.success ? String(response.data.code) : "INVALID_RESPONSE",
        "Failed to obtain Feishu tenant access token",
        true,
      );
    }
    this.token = {
      expiresAt: this.now() + response.data.expire * 1000,
      value: response.data.tenant_access_token,
    };
    return this.token.value;
  }

  private async fetchResponse(path: string | URL, init: RequestInit) {
    const url =
      path instanceof URL
        ? path
        : new URL(path, `${this.baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new FeishuApiError(
          `HTTP_${response.status}`,
          `Feishu API request failed with HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof FeishuApiError) throw error;
      throw new FeishuApiError(
        controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        controller.signal.aborted
          ? "Feishu API request timed out"
          : "Feishu API network request failed",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJson(response: Response) {
    try {
      return await response.json();
    } catch {
      throw new FeishuApiError(
        "INVALID_RESPONSE",
        "Feishu API returned invalid JSON",
        true,
      );
    }
  }

  private async readBinaryBody(response: Response) {
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_SOURCE_IMAGE_BYTES) {
        await reader.cancel();
        throw new FeishuApiError(
          "MEDIA_TOO_LARGE",
          "Feishu media exceeds the 8 MiB download limit",
          false,
        );
      }

      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
}
