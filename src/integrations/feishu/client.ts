import { z } from "zod";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type RequestState = {
  abortReason: null | "size-limit" | "timeout";
  controller: AbortController;
  timeoutHandle: ReturnType<typeof setTimeout>;
  timeoutPromise: Promise<never>;
};

export const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;

const FEISHU_PERMISSION_MESSAGE =
  "\u98de\u4e66\u6587\u6863\u6743\u9650\u4e0d\u8db3\uff0c\u8bf7\u5c06\u5e94\u7528\u6dfb\u52a0\u4e3a\u77e5\u8bc6\u5e93\u6216\u7535\u5b50\u8868\u683c\u534f\u4f5c\u8005";
const FEISHU_NON_SHEET_MESSAGE =
  "\u98de\u4e66\u77e5\u8bc6\u5e93\u8282\u70b9\u4e0d\u662f\u7535\u5b50\u8868\u683c";
const FEISHU_INVALID_RESPONSE_MESSAGE =
  "\u98de\u4e66\u63a5\u53e3\u54cd\u5e94\u683c\u5f0f\u65e0\u6548";
const FEISHU_TOKEN_FAILURE_MESSAGE =
  "\u98de\u4e66\u5e94\u7528\u8bbf\u95ee\u51ed\u8bc1\u83b7\u53d6\u5931\u8d25";
const FEISHU_TIMEOUT_MESSAGE =
  "\u98de\u4e66\u63a5\u53e3\u8bf7\u6c42\u8d85\u65f6";
const FEISHU_NETWORK_ERROR_MESSAGE =
  "\u98de\u4e66\u63a5\u53e3\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25";
const FEISHU_MEDIA_TOO_LARGE_MESSAGE =
  "\u98de\u4e66\u7d20\u6750\u8d85\u8fc7 8 MiB \u4e0a\u9650";

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

function feishuHttpMessage(status: number) {
  return `\u98de\u4e66\u63a5\u53e3\u7f51\u7edc\u54cd\u5e94\u5f02\u5e38\uff08${status}\uff09`;
}

function feishuCodeMessage(code: number) {
  if (code === 1310213 || code === 131006) {
    return FEISHU_PERMISSION_MESSAGE;
  }
  return `\u98de\u4e66\u63a5\u53e3\u8c03\u7528\u5931\u8d25\uff08${code}\uff09`;
}

function invalidResponseError() {
  return new FeishuApiError(
    "INVALID_RESPONSE",
    FEISHU_INVALID_RESPONSE_MESSAGE,
    true,
  );
}

function mediaTooLargeError() {
  return new FeishuApiError(
    "MEDIA_TOO_LARGE",
    FEISHU_MEDIA_TOO_LARGE_MESSAGE,
    false,
  );
}

function timeoutError() {
  return new FeishuApiError("TIMEOUT", FEISHU_TIMEOUT_MESSAGE, true);
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
        FEISHU_NON_SHEET_MESSAGE,
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
    if (!valueRange?.range || valueRange.revision === undefined) {
      throw invalidResponseError();
    }

    return {
      range: valueRange.range,
      revision: valueRange.revision,
      values: valueRange.values ?? [],
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
    return this.authorizedRequest(
      `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`,
      {},
      async (response, state) => {
        const declaredLength = Number.parseInt(
          response.headers.get("Content-Length") ?? "",
          10,
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_SOURCE_IMAGE_BYTES
        ) {
          await this.abortForSizeLimit(response, state);
          throw mediaTooLargeError();
        }

        return {
          bytes: await this.readBinaryBody(response, state),
          contentType:
            response.headers.get("Content-Type") ?? "application/octet-stream",
          fileName: parseSuggestedFileName(
            response.headers.get("Content-Disposition"),
          ),
        };
      },
    );
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
      throw invalidResponseError();
    }
    const code = response.data.code;
    throw new FeishuApiError(
      String(code),
      feishuCodeMessage(code),
      code >= 99990000 || code === 1315201 || code === 1315203,
    );
  }

  private async authorizedJson(path: string | URL, init: RequestInit = {}) {
    return this.authorizedRequest(
      path,
      {
        ...init,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...init.headers,
        },
      },
      async (response, state) => this.parseJson(response, state),
    );
  }

  private async authorizedRequest<T>(
    path: string | URL,
    init: RequestInit,
    reader: (response: Response, state: RequestState) => Promise<T>,
  ) {
    const token = await this.tenantToken();
    return this.withRequest(
      path,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      },
      reader,
    );
  }

  private async tenantToken() {
    if (this.token && this.token.expiresAt - 5 * 60_000 > this.now()) {
      return this.token.value;
    }

    let payload: unknown;
    try {
      payload = await this.withRequest(
        "/open-apis/auth/v3/tenant_access_token/internal",
        {
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
          headers: { "Content-Type": "application/json; charset=utf-8" },
          method: "POST",
        },
        async (response, state) => this.parseJson(response, state),
      );
    } catch (error) {
      if (error instanceof FeishuApiError && error.code === "INVALID_RESPONSE") {
        throw new FeishuApiError(
          "INVALID_RESPONSE",
          FEISHU_TOKEN_FAILURE_MESSAGE,
          true,
        );
      }
      throw error;
    }

    const response = tokenResponseSchema.safeParse(payload);
    if (!response.success || response.data.code !== 0) {
      throw new FeishuApiError(
        response.success ? String(response.data.code) : "INVALID_RESPONSE",
        FEISHU_TOKEN_FAILURE_MESSAGE,
        true,
      );
    }

    this.token = {
      expiresAt: this.now() + response.data.expire * 1000,
      value: response.data.tenant_access_token,
    };
    return this.token.value;
  }

  private async withRequest<T>(
    path: string | URL,
    init: RequestInit,
    reader: (response: Response, state: RequestState) => Promise<T>,
  ) {
    const state = this.createRequestState();
    try {
      const response = await this.fetchResponse(path, init, state);
      return await reader(response, state);
    } catch (error) {
      if (error instanceof FeishuApiError) {
        throw error;
      }
      if (state.abortReason === "timeout") {
        throw timeoutError();
      }
      throw new FeishuApiError(
        "NETWORK_ERROR",
        FEISHU_NETWORK_ERROR_MESSAGE,
        true,
      );
    } finally {
      clearTimeout(state.timeoutHandle);
    }
  }

  private createRequestState(): RequestState {
    const controller = new AbortController();
    let rejectTimeout: (error: FeishuApiError) => void = () => {};
    const state: RequestState = {
      abortReason: null,
      controller,
      timeoutHandle: setTimeout(() => {
        state.abortReason = "timeout";
        controller.abort();
        rejectTimeout(timeoutError());
      }, this.timeoutMs),
      timeoutPromise: new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      }),
    };
    return state;
  }

  private async fetchResponse(
    path: string | URL,
    init: RequestInit,
    state: RequestState,
  ) {
    const url =
      path instanceof URL
        ? path
        : new URL(path, `${this.baseUrl}/`);
    const response = await Promise.race([
      this.fetcher(url, { ...init, signal: state.controller.signal }),
      state.timeoutPromise,
    ]);
    if (!response.ok) {
      throw new FeishuApiError(
        `HTTP_${response.status}`,
        feishuHttpMessage(response.status),
        response.status === 429 || response.status >= 500,
      );
    }
    return response;
  }

  private async parseJson(response: Response, state: RequestState) {
    const text = await Promise.race([response.text(), state.timeoutPromise]);
    try {
      return JSON.parse(text);
    } catch {
      throw invalidResponseError();
    }
  }

  private async abortForSizeLimit(response: Response, state: RequestState) {
    state.abortReason = "size-limit";
    try {
      await response.body?.cancel();
    } catch {}
    state.controller.abort();
  }

  private async readBinaryBody(response: Response, state: RequestState) {
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      const result = await Promise.race([reader.read(), state.timeoutPromise]);
      if (result.done) break;
      if (!result.value) continue;

      total += result.value.byteLength;
      if (total > MAX_SOURCE_IMAGE_BYTES) {
        state.abortReason = "size-limit";
        await reader.cancel();
        state.controller.abort();
        throw mediaTooLargeError();
      }

      chunks.push(result.value);
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
