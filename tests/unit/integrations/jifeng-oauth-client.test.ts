import { afterEach, describe, expect, test, vi } from "vitest";

import {
  authorizeJifengUser,
  exchangeJifengAuthorizationCode,
  refreshJifengTokenSet,
} from "@/integrations/jifeng/oauth-client";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const tokenData = {
  accessToken: "access-token-value",
  expireIn: 86_400,
  refreshExpireIn: 31_536_000,
  refreshToken: "refresh-token-value",
  userId: 8,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Jifeng official authorization client", () => {
  test("authorize sends only the four official query parameters and returns data as the authorization code", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      void input;
      void init;
      return Response.json({
        code: 0,
        data: "authorization-code-value",
        message: "SUCCESS",
        requestId: "authorize-request",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authorizeJifengUser({
        baseUrl: "https://api.example.test/",
        clientId: "client-id-value",
        domain: "merchant.example.test",
        email: "operator@example.test",
        oneTimeToken: "one-time-token-value",
      }),
    ).resolves.toEqual({
      authorizationCode: "authorization-code-value",
      requestId: "authorize-request",
    });

    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.example.test/api/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      clientId: "client-id-value",
      domain: "merchant.example.test",
      email: "operator@example.test",
      token: "one-time-token-value",
    });
    expect([...url.searchParams.keys()].sort()).toEqual([
      "clientId",
      "domain",
      "email",
      "token",
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("access-token exchange sends only clientId, clientSecret, and key", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      void input;
      void init;
      return Response.json({
        code: "0",
        data: tokenData,
        message: "SUCCESS",
        requestId: "exchange-request",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exchangeJifengAuthorizationCode({
        authorizationCode: "authorization-code-value",
        baseUrl: "https://api.example.test",
        clientId: "client-id-value",
        clientSecret: "client-secret-value",
      }),
    ).resolves.toEqual({
      accessToken: "access-token-value",
      expireIn: 86_400,
      refreshExpireIn: 31_536_000,
      refreshToken: "refresh-token-value",
      requestId: "exchange-request",
      userId: "8",
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.example.test/api/oauth/accessToken",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      clientId: "client-id-value",
      clientSecret: "client-secret-value",
      key: "authorization-code-value",
    });
    expect([...url.searchParams.keys()].sort()).toEqual([
      "clientId",
      "clientSecret",
      "key",
    ]);
  });

  test("refresh sends only the four project-approved official query parameters", async () => {
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      void input;
      void init;
      return Response.json({ code: 0, data: tokenData, message: "SUCCESS" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshJifengTokenSet({
      baseUrl: "https://api.example.test",
      clientId: "client-id-value",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value",
      userId: "8",
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.example.test/api/oauth/refreshToken",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      clientId: "client-id-value",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value",
      userId: "8",
    });
    expect([...url.searchParams.keys()].sort()).toEqual([
      "clientId",
      "clientSecret",
      "refreshToken",
      "userId",
    ]);
  });

  test.each([
    [{ ...tokenData, accessToken: "" }, "empty access token"],
    [{ ...tokenData, refreshToken: "" }, "empty refresh token"],
    [{ ...tokenData, userId: "" }, "empty user id"],
    [{ ...tokenData, expireIn: 0 }, "zero access expiry"],
    [{ ...tokenData, expireIn: 1.5 }, "fractional access expiry"],
    [{ ...tokenData, refreshExpireIn: -1 }, "negative refresh expiry"],
  ])("rejects malformed token data: %s (%s)", async (data, _label) => {
    void _label;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: 0, data, message: "do not expose this" }),
      ),
    );

    await expect(
      exchangeJifengAuthorizationCode({
        authorizationCode: "authorization-code-value",
        baseUrl: "https://api.example.test",
        clientId: "client-id-value",
        clientSecret: "client-secret-value",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: false });
  });

  test("returns a classified error without exposing request URLs or authorization secrets", async () => {
    const secrets = [
      "authorization-code-value",
      "client-secret-value",
      "server-echoed-token",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          code: 10026,
          data: null,
          message: `rejected ${secrets.join(" ")}`,
          requestId: "client-secret-value",
        }),
      ),
    );

    const error = await exchangeJifengAuthorizationCode({
      authorizationCode: secrets[0],
      baseUrl: "https://api.example.test",
      clientId: "client-id-value",
      clientSecret: secrets[1],
    }).catch((cause: unknown) => cause);
    const serialized = JSON.stringify(error);

    expect(error).toMatchObject({
      code: "10026",
      retryable: false,
    });
    expect(error).toHaveProperty("requestId", undefined);
    expect((error as Error).message).toBe("Jifeng authorization request failed");
    for (const secret of secrets) {
      expect(`${(error as Error).message} ${serialized}`).not.toContain(secret);
    }
    expect(`${(error as Error).message} ${serialized}`).not.toContain("?");
  });

  test("aborts an authorization request after ten seconds with a sanitized timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted token=do-not-expose", "AbortError"));
          });
        }),
      ),
    );

    const request = authorizeJifengUser({
      baseUrl: "https://api.example.test",
      clientId: "client-id-value",
      domain: "merchant.example.test",
      email: "operator@example.test",
      oneTimeToken: "one-time-token-value",
    });
    const assertion = expect(request).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Jifeng authorization request timed out",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
