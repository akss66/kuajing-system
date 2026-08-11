import { z } from "zod";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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
      valueRange: z
        .object({ values: z.array(z.array(z.unknown())).optional().default([]) })
        .optional(),
    })
    .optional(),
});

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
    return "飞书文档权限不足，请将应用添加为知识库或电子表格协作者";
  }
  return `飞书接口调用失败（${code}）`;
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
        "飞书知识库节点不是电子表格",
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

  async readRange(input: { range: string; spreadsheetToken: string }) {
    const response = rangeResponseSchema.safeParse(
      await this.authorizedJson(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(input.range)}`,
      ),
    );
    if (!response.success || response.data.code !== 0 || !response.data.data) {
      this.throwResponseError(response);
    }
    return response.data.data.valueRange?.values ?? [];
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
        "飞书接口响应格式无效",
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
    const token = await this.tenantToken();
    return this.fetchJson(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        ...init.headers,
      },
    });
  }

  private async tenantToken() {
    if (this.token && this.token.expiresAt - 5 * 60_000 > this.now()) {
      return this.token.value;
    }
    const response = tokenResponseSchema.safeParse(
      await this.fetchJson("/open-apis/auth/v3/tenant_access_token/internal", {
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        headers: { "Content-Type": "application/json; charset=utf-8" },
        method: "POST",
      }),
    );
    if (!response.success || response.data.code !== 0) {
      throw new FeishuApiError(
        response.success ? String(response.data.code) : "INVALID_RESPONSE",
        "飞书应用访问凭证获取失败",
        true,
      );
    }
    this.token = {
      expiresAt: this.now() + response.data.expire * 1000,
      value: response.data.tenant_access_token,
    };
    return this.token.value;
  }

  private async fetchJson(path: string | URL, init: RequestInit) {
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
          `飞书接口网络响应异常（${response.status}）`,
          response.status === 429 || response.status >= 500,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof FeishuApiError) throw error;
      throw new FeishuApiError(
        controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        controller.signal.aborted ? "飞书接口请求超时" : "飞书接口网络请求失败",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
