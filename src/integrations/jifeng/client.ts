import { z } from "zod";

import {
  createJifengNonce,
  signJifengRequest,
  type JifengSigningInput,
} from "./signing";
import type {
  JifengCreateOrderInput,
  JifengCredentials,
  JifengOrderDetail,
} from "./types";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const responseSchema = z.object({
  code: z.coerce.number().int(),
  data: z.unknown().nullable().optional(),
  message: z.string().optional().default(""),
  requestId: z.string().optional(),
});

const orderDetailSchema = z.object({
  currency: z.string().optional(),
  erpNo: z.string(),
  errorCode: z.coerce.number().int().optional(),
  errorMsg: z.string().optional(),
  logisticsFee: z.coerce.number().nonnegative().optional(),
  orderNo: z.string().optional(),
  shippedTime: z.string().optional(),
  status: z.coerce.number().int().min(1).max(11),
  trackingNo: z.string().optional(),
});

const refreshResponseSchema = responseSchema.extend({
  data: z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1).optional(),
      userId: z.coerce.string().optional(),
    })
    .nullable(),
});

const accessTokenErrorCodes = new Set([10002, 10015, 10016]);
const retryableCodes = new Set([-1, 1, 10017, 10018, 50038]);

export class JifengApiError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    requestId?: string;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = "JifengApiError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.retryable = input.retryable;
  }
}

export class JifengClient {
  private readonly credentials: JifengCredentials;
  private readonly fetcher: FetchLike;
  private readonly nonce: () => string;
  private readonly now: () => number;
  private readonly onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken?: string;
  }) => void | Promise<void>;
  private readonly timeoutMs: number;

  constructor(input: {
    credentials: JifengCredentials;
    fetch?: FetchLike;
    nonce?: () => string;
    now?: () => number;
    onTokensRefreshed?: (tokens: {
      accessToken: string;
      refreshToken?: string;
    }) => void | Promise<void>;
    timeoutMs?: number;
  }) {
    this.credentials = {
      ...input.credentials,
      baseUrl: input.credentials.baseUrl.replace(/\/$/, ""),
    };
    this.fetcher = input.fetch ?? fetch;
    this.nonce = input.nonce ?? createJifengNonce;
    this.now = input.now ?? Date.now;
    this.onTokensRefreshed = input.onTokensRefreshed;
    this.timeoutMs = input.timeoutMs ?? 15_000;
  }

  async createOrder(input: JifengCreateOrderInput) {
    const response = await this.businessPost("/api/order/create", input);
    return { data: response.data, requestId: response.requestId };
  }

  async getOrder(input: {
    erpNo?: string;
    platformOrderNo?: string;
  }): Promise<JifengOrderDetail> {
    const response = await this.businessPost("/api/order/get", input);
    const parsed = orderDetailSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new JifengApiError({
        code: "INVALID_RESPONSE",
        message: "极风订单响应格式无效",
        requestId: response.requestId,
        retryable: true,
      });
    }
    return parsed.data;
  }

  async cancelOrder(input: { deleteRecord?: boolean; erpNo: string }) {
    const response = await this.businessPost("/api/order/cancel", input);
    return { data: response.data, requestId: response.requestId };
  }

  private async businessPost(
    path: string,
    body: unknown,
    refreshed = false,
  ): Promise<z.infer<typeof responseSchema>> {
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const signingInput: JifengSigningInput = {
      accessToken: this.credentials.accessToken,
      clientId: this.credentials.clientId,
      method: "post",
      nonce,
      timestamp,
      url: path,
      userId: this.credentials.userId,
    };
    const response = await this.fetchJson(
      `${this.credentials.baseUrl}${path}`,
      {
        body: JSON.stringify(body),
        headers: {
          "Accept-Language": "zh_CN",
          "Content-Type": "application/json; charset=utf-8",
          accessToken: this.credentials.accessToken,
          clientId: this.credentials.clientId,
          nonce,
          sign: signJifengRequest(this.credentials.clientSecret, signingInput),
          timestamp,
          userId: this.credentials.userId,
        },
        method: "POST",
      },
    );
    const parsed = responseSchema.safeParse(response);
    if (!parsed.success) {
      throw new JifengApiError({
        code: "INVALID_RESPONSE",
        message: "极风接口响应格式无效",
        retryable: true,
      });
    }
    if (parsed.data.code === 0) return parsed.data;

    if (
      !refreshed &&
      accessTokenErrorCodes.has(parsed.data.code) &&
      this.credentials.refreshToken
    ) {
      await this.refreshAccessToken();
      return this.businessPost(path, body, true);
    }

    throw new JifengApiError({
      code: String(parsed.data.code),
      message: `极风接口调用失败（${parsed.data.code}）`,
      requestId: parsed.data.requestId,
      retryable: retryableCodes.has(parsed.data.code),
    });
  }

  private async refreshAccessToken() {
    const refreshToken = this.credentials.refreshToken;
    if (!refreshToken) {
      throw new JifengApiError({
        code: "REFRESH_TOKEN_MISSING",
        message: "极风刷新令牌未配置",
        retryable: false,
      });
    }
    const url = new URL(
      "/api/oauth/refreshToken",
      `${this.credentials.baseUrl}/`,
    );
    url.searchParams.set("clientId", this.credentials.clientId);
    url.searchParams.set("clientSecret", this.credentials.clientSecret);
    url.searchParams.set("refreshToken", refreshToken);
    url.searchParams.set("userId", this.credentials.userId);

    const response = await this.fetchJson(url, { method: "GET" });
    const parsed = refreshResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data) {
      throw new JifengApiError({
        code: parsed.success ? String(parsed.data.code) : "INVALID_RESPONSE",
        message: "极风访问令牌刷新失败",
        requestId: parsed.success ? parsed.data.requestId : undefined,
        retryable: false,
      });
    }

    this.credentials.accessToken = parsed.data.data.accessToken;
    if (parsed.data.data.refreshToken) {
      this.credentials.refreshToken = parsed.data.data.refreshToken;
    }
    await this.onTokensRefreshed?.({
      accessToken: this.credentials.accessToken,
      refreshToken: this.credentials.refreshToken,
    });
  }

  private async fetchJson(url: string | URL, request: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...request,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new JifengApiError({
          code: `HTTP_${response.status}`,
          message: `极风接口网络响应异常（${response.status}）`,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return await response.json();
    } catch (error) {
      if (error instanceof JifengApiError) throw error;
      throw new JifengApiError({
        code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
        message: controller.signal.aborted
          ? "极风接口请求超时"
          : "极风接口网络请求失败",
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
