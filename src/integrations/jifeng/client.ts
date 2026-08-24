import { z } from "zod";

import {
  createJifengNonce,
  signJifengRequest,
  type JifengSigningInput,
} from "./signing";
import {
  JifengAuthorizationError,
  refreshJifengTokenSet,
} from "./oauth-client";
import {
  parseJifengOfflineLogistics,
  parseJifengWarehouses,
} from "./resources";
import type {
  JifengCredentials,
  JifengOfflineLogistics,
  JifengOrderDetail,
  JifengWarehouse,
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

const nullableOptionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableOptionalInteger = z
  .coerce.number()
  .int()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableOptionalNonnegativeNumber = z
  .coerce.number()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? undefined);

const orderDetailSchema = z.object({
  currency: nullableOptionalString,
  erpNo: z.string(),
  errorCode: nullableOptionalInteger,
  errorMsg: nullableOptionalString,
  logisticsFee: nullableOptionalNonnegativeNumber,
  orderNo: nullableOptionalString,
  platformOrderNo: nullableOptionalString,
  shippedTime: nullableOptionalString,
  status: z.coerce.number().int().min(1).max(11),
  trackingNo: nullableOptionalString,
});

const orderPageSchema = z.object({
  pageNo: z.coerce.number().int().optional(),
  pageSize: z.coerce.number().int().optional(),
  rows: z.array(orderDetailSchema),
  totalPage: z.coerce.number().int().optional(),
  totalSize: z.coerce.number().int().optional(),
});

const accessTokenErrorCodes = new Set([10002, 10015, 10016]);
// Official business codes 50019 (ERP order exists) and 50038 (processing)
// require an order query/reconciliation; blind create retries can duplicate orders.
const retryableCodes = new Set([-1, 1, 10017, 10018]);
const safeBusinessErrorMessages = new Map<number, string>([
  [50026, "极风仓库对应 SKU 库存不足，请先同步或补充仓库库存"],
]);

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
  private readonly automaticRefresh: boolean;
  private readonly credentials: JifengCredentials;
  private readonly fetcher: FetchLike;
  private readonly nonce: () => string;
  private readonly now: () => number;
  private readonly onAuthenticationRejected?: () => void | Promise<void>;
  private readonly onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken?: string;
  }) => void | Promise<void>;
  private readonly timeoutMs: number;

  constructor(input: {
    automaticRefresh?: boolean;
    credentials: JifengCredentials;
    fetch?: FetchLike;
    nonce?: () => string;
    now?: () => number;
    onAuthenticationRejected?: () => void | Promise<void>;
    onTokensRefreshed?: (tokens: {
      accessToken: string;
      refreshToken?: string;
    }) => void | Promise<void>;
    timeoutMs?: number;
  }) {
    this.automaticRefresh = input.automaticRefresh ?? true;
    this.credentials = {
      ...input.credentials,
      baseUrl: input.credentials.baseUrl.replace(/\/$/, ""),
    };
    this.fetcher = input.fetch ?? fetch;
    this.nonce = input.nonce ?? createJifengNonce;
    this.now = input.now ?? Date.now;
    this.onAuthenticationRejected = input.onAuthenticationRejected;
    this.onTokensRefreshed = input.onTokensRefreshed;
    this.timeoutMs = input.timeoutMs ?? 10_000;
  }

  async getOrder(input: {
    erpNo?: string;
    platformOrderNo?: string;
  }): Promise<JifengOrderDetail> {
    if (input.platformOrderNo !== undefined) {
      return this.getOrderByPlatformOrderNo(input.platformOrderNo);
    }
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

  private async getOrderByPlatformOrderNo(
    platformOrderNo: string,
  ): Promise<JifengOrderDetail> {
    // The single-order endpoint is keyed by erpNo. Jifeng's documented exact
    // platform-order lookup is the paged endpoint:
    // https://s.apifox.cn/25bf1c44-f535-4c37-9bf4-7244130a67ce/api-505074713
    const exactMatches = new Map<string, JifengOrderDetail>();
    let currentPage = 1;
    let requestId: string | undefined;
    let totalPage = 1;

    while (currentPage <= totalPage) {
      const response = await this.businessPost("/api/order/page", {
        pageNo: currentPage,
        pageSize: 300,
        platformOrderNo,
      });
      requestId = response.requestId;
      const parsed = orderPageSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new JifengApiError({
          code: "INVALID_RESPONSE",
          message: "极风订单分页响应格式无效",
          requestId: response.requestId,
          retryable: true,
        });
      }

      totalPage = Math.max(parsed.data.totalPage ?? currentPage, currentPage);
      for (const order of parsed.data.rows) {
        if (order.platformOrderNo === platformOrderNo) {
          exactMatches.set(order.erpNo, order);
        }
      }
      currentPage += 1;
    }

    if (exactMatches.size === 0) {
      throw new JifengApiError({
        code: "50017",
        message: "极风仓库暂未找到该平台订单",
        requestId,
        retryable: false,
      });
    }
    if (exactMatches.size > 1) {
      throw new JifengApiError({
        code: "AMBIGUOUS_PLATFORM_ORDER",
        message: "极风返回多个相同平台订单号，已停止自动绑定",
        requestId,
        retryable: false,
      });
    }
    return exactMatches.values().next().value as JifengOrderDetail;
  }

  async cancelOrder(input: { deleteRecord?: boolean; erpNo: string }) {
    const response = await this.businessPost("/api/order/cancel", input);
    return { data: response.data, requestId: response.requestId };
  }

  async getWarehouses(): Promise<JifengWarehouse[]> {
    const response = await this.businessPost("/api/warehouse/getList", {
      codeList: [],
    });
    try {
      return parseJifengWarehouses(response.data);
    } catch {
      throw new JifengApiError({
        code: "INVALID_RESPONSE",
        message: "极风仓库响应格式无效",
        requestId: response.requestId,
        retryable: true,
      });
    }
  }

  async getOfflineLogistics(): Promise<JifengOfflineLogistics[]> {
    const response = await this.businessPost("/api/logistics/offline/page", {
      pageNo: 1,
      pageSize: 300,
      returnAll: true,
    });
    try {
      return parseJifengOfflineLogistics(response.data);
    } catch {
      throw new JifengApiError({
        code: "INVALID_RESPONSE",
        message: "极风物流响应格式无效",
        requestId: response.requestId,
        retryable: true,
      });
    }
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

    if (!refreshed && accessTokenErrorCodes.has(parsed.data.code)) {
      if (this.automaticRefresh && this.credentials.refreshToken) {
        await this.refreshAccessToken();
        return this.businessPost(path, body, true);
      }
      if (!this.automaticRefresh) {
        await this.onAuthenticationRejected?.();
        throw new JifengApiError({
          code: "REFRESH_REQUIRED",
          message: "极风连接需要重新授权",
          requestId: parsed.data.requestId,
          retryable: false,
        });
      }
    }

    throw new JifengApiError({
      code: String(parsed.data.code),
      message:
        safeBusinessErrorMessages.get(parsed.data.code) ??
        `极风接口调用失败（${parsed.data.code}）`,
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
    let tokens;
    try {
      tokens = await refreshJifengTokenSet(
        {
          baseUrl: this.credentials.baseUrl,
          clientId: this.credentials.clientId,
          clientSecret: this.credentials.clientSecret,
          refreshToken,
          userId: this.credentials.userId,
        },
        { fetch: this.fetcher, timeoutMs: this.timeoutMs },
      );
    } catch (error) {
      if (error instanceof JifengAuthorizationError) {
        throw new JifengApiError({
          code: error.code,
          message: "极风访问令牌刷新失败",
          requestId: error.requestId,
          retryable: error.retryable,
        });
      }
      throw new JifengApiError({
        code: "NETWORK_ERROR",
        message: "极风访问令牌刷新失败",
        retryable: true,
      });
    }

    this.credentials.accessToken = tokens.accessToken;
    this.credentials.refreshToken = tokens.refreshToken;
    this.credentials.userId = tokens.userId;
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
