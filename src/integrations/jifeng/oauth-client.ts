import { z } from "zod";

import type { JifengRefreshInput, JifengTokenSet } from "./types";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type RequestOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const retryableCodes = new Set([-1, 1, 10017, 10018]);
const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/)
  .optional();
const envelopeSchema = z.object({
  code: z.coerce.number().int(),
  data: z.unknown().nullable().optional(),
  requestId: requestIdSchema,
});
const authorizationResponseSchema = envelopeSchema.extend({
  data: z.string().trim().min(1),
});
const tokenDataSchema = z.object({
  accessToken: z.string().trim().min(1),
  expireIn: z.coerce.number().int().positive(),
  refreshExpireIn: z.coerce.number().int().positive(),
  refreshToken: z.string().trim().min(1),
  userId: z
    .union([z.string().trim().min(1), z.number().int()])
    .transform(String),
});
const tokenResponseSchema = envelopeSchema.extend({
  data: tokenDataSchema,
});

export class JifengAuthorizationError extends Error {
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
    this.name = "JifengAuthorizationError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.retryable = input.retryable;
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string>,
) {
  try {
    const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url;
  } catch {
    throw new JifengAuthorizationError({
      code: "INVALID_REQUEST",
      message: "Jifeng authorization request is invalid",
      retryable: false,
    });
  }
}

async function fetchAuthorizationJson(
  url: URL,
  options: RequestOptions = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new JifengAuthorizationError({
        code: `HTTP_${response.status}`,
        message: "Jifeng authorization request failed",
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return await response.json();
  } catch (error) {
    if (error instanceof JifengAuthorizationError) throw error;
    throw new JifengAuthorizationError({
      code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
      message: controller.signal.aborted
        ? "Jifeng authorization request timed out"
        : "Jifeng authorization network request failed",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function throwInvalidResponse(): never {
  throw new JifengAuthorizationError({
    code: "INVALID_RESPONSE",
    message: "Jifeng authorization response is invalid",
    retryable: false,
  });
}

function throwBusinessError(input: {
  code: number;
  requestId?: string;
}, sensitiveValues: string[]): never {
  throw new JifengAuthorizationError({
    code: String(input.code),
    message: "Jifeng authorization request failed",
    requestId: sanitizeRequestId(input.requestId, sensitiveValues),
    retryable: retryableCodes.has(input.code),
  });
}

function sanitizeRequestId(
  requestId: string | undefined,
  sensitiveValues: string[],
) {
  if (
    requestId &&
    sensitiveValues.some(
      (value) => value.length > 0 && requestId.includes(value),
    )
  ) {
    return undefined;
  }
  return requestId;
}

export async function authorizeJifengUser(input: {
  baseUrl: string;
  clientId: string;
  domain: string;
  email: string;
  oneTimeToken: string;
}): Promise<{ authorizationCode: string; requestId?: string }> {
  const url = buildUrl(input.baseUrl, "/api/oauth/authorize", {
    domain: input.domain,
    clientId: input.clientId,
    email: input.email,
    token: input.oneTimeToken,
  });
  const response = await fetchAuthorizationJson(url);
  const envelope = envelopeSchema.safeParse(response);
  if (!envelope.success) throwInvalidResponse();
  const sensitiveValues = [input.email, input.oneTimeToken];
  if (envelope.data.code !== 0) {
    throwBusinessError(envelope.data, sensitiveValues);
  }
  const parsed = authorizationResponseSchema.safeParse(response);
  if (!parsed.success) throwInvalidResponse();
  return {
    authorizationCode: parsed.data.data,
    requestId: sanitizeRequestId(parsed.data.requestId, sensitiveValues),
  };
}

export async function exchangeJifengAuthorizationCode(input: {
  authorizationCode: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<JifengTokenSet> {
  return requestTokenSet(
    buildUrl(input.baseUrl, "/api/oauth/accessToken", {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      key: input.authorizationCode,
    }),
    undefined,
    [input.authorizationCode, input.clientSecret],
  );
}

export async function refreshJifengTokenSet(
  input: JifengRefreshInput,
  options?: RequestOptions,
): Promise<JifengTokenSet> {
  return requestTokenSet(
    buildUrl(input.baseUrl, "/api/oauth/refreshToken", {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.refreshToken,
      userId: input.userId,
    }),
    options,
    [input.clientSecret, input.refreshToken],
  );
}

async function requestTokenSet(
  url: URL,
  options?: RequestOptions,
  sensitiveValues: string[] = [],
): Promise<JifengTokenSet> {
  const response = await fetchAuthorizationJson(url, options);
  const envelope = envelopeSchema.safeParse(response);
  if (!envelope.success) throwInvalidResponse();
  if (envelope.data.code !== 0) {
    throwBusinessError(envelope.data, sensitiveValues);
  }
  const parsed = tokenResponseSchema.safeParse(response);
  if (!parsed.success) throwInvalidResponse();
  return {
    ...parsed.data.data,
    requestId: sanitizeRequestId(parsed.data.requestId, sensitiveValues),
  };
}
