import { describe, expect, test, vi } from "vitest";

import {
  JifengApiError,
  JifengClient,
  buildJifengCanonicalString,
  signJifengRequest,
  type JifengSigningInput,
} from "@/integrations/jifeng";

const credentials = {
  accessToken: "1b56814f081c432cb82751be145261d3",
  baseUrl: "https://test.jfwms.com",
  clientId: "fe73489a9b5948dbafd07e7b28d6e268",
  clientSecret: "4a506ccaf37e400bac4a42d2dc5f600a",
  refreshToken: "refresh-token",
  userId: "8",
};

describe("Jifeng API client", () => {
  test("matches the official HMAC-SHA256 signing vector", () => {
    const input: JifengSigningInput = {
      accessToken: credentials.accessToken,
      clientId: credentials.clientId,
      method: "post",
      nonce: "14",
      timestamp: "1692889556000",
      url: "/api/order/get",
      userId: credentials.userId,
    };

    expect(buildJifengCanonicalString(input)).toBe(
      "accessToken=1b56814f081c432cb82751be145261d3&clientId=fe73489a9b5948dbafd07e7b28d6e268&method=post&nonce=14&timestamp=1692889556000&url=/api/order/get&userId=8",
    );
    expect(signJifengRequest(credentials.clientSecret, input)).toBe(
      "9bc08ba7552c5dfea4efab6bda78a4a9738010913f2403bd93f09c6bf974b939",
    );
  });

  test("signs a POST request and validates the order response", async () => {
    const fetchMock = vi.fn(
      async (requestInput: RequestInfo | URL, requestInit?: RequestInit) => {
        void requestInput;
        void requestInit;
        return new Response(
        JSON.stringify({
          code: 0,
          data: {
            currency: "CAD",
            erpNo: "TZX-JF-001",
            logisticsFee: 8.75,
            shippedTime: "2026-08-12 12:00:00",
            status: 7,
            trackingNo: "CP123456789CA",
          },
          message: "SUCCESS",
          requestId: "request-1",
        }),
        { status: 200 },
        );
      },
    );
    const client = new JifengClient({
      credentials,
      fetch: fetchMock,
      nonce: () => "14",
      now: () => 1_692_889_556_000,
    });

    const result = await client.getOrder({ erpNo: "TZX-JF-001" });

    expect(result).toMatchObject({
      currency: "CAD",
      erpNo: "TZX-JF-001",
      logisticsFee: 8.75,
      status: 7,
      trackingNo: "CP123456789CA",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://test.jfwms.com/api/order/get");
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({ erpNo: "TZX-JF-001" });
    const headers = new Headers(request?.headers);
    expect(headers.get("clientId")).toBe(credentials.clientId);
    expect(headers.get("accessToken")).toBe(credentials.accessToken);
    expect(headers.get("userId")).toBe(credentials.userId);
    expect(headers.get("timestamp")).toBe("1692889556000");
    expect(headers.get("nonce")).toBe("14");
    expect(headers.get("sign")).toBe(
      "9bc08ba7552c5dfea4efab6bda78a4a9738010913f2403bd93f09c6bf974b939",
    );
    expect(headers.get("Accept-Language")).toBe("zh_CN");
  });

  test("accepts nullable optional fields returned by the production order query", async () => {
    const client = new JifengClient({
      credentials,
      fetch: vi.fn(async () =>
        Response.json({
          code: 0,
          data: {
            currency: null,
            erpNo: "TZX-6262f1e6f19c40b09016f51cc7b2cac4",
            errorCode: null,
            errorMsg: null,
            logisticsFee: null,
            orderNo: "PNJ1412823",
            shippedTime: null,
            status: 2,
            trackingNo: "6064889708473275",
          },
          message: "SUCCESS",
          requestId: "production-shaped-response",
        }),
      ),
      nonce: () => "14",
      now: () => 1_692_889_556_000,
    });

    await expect(
      client.getOrder({
        erpNo: "TZX-6262f1e6f19c40b09016f51cc7b2cac4",
      }),
    ).resolves.toEqual({
      currency: undefined,
      erpNo: "TZX-6262f1e6f19c40b09016f51cc7b2cac4",
      errorCode: undefined,
      errorMsg: undefined,
      logisticsFee: undefined,
      orderNo: "PNJ1412823",
      shippedTime: undefined,
      status: 2,
      trackingNo: "6064889708473275",
    });
  });

  test.each([
    [
      "warehouses",
      (client: JifengClient) => client.getWarehouses(),
      "/api/warehouse/getList",
      { codeList: [] },
      { code: 0, data: [{ code: "CA-YYZ", name: "Toronto", country: "CA" }] },
      [{ code: "CA-YYZ", name: "Toronto", country: "CA" }],
    ],
    [
      "offline logistics",
      (client: JifengClient) => client.getOfflineLogistics(),
      "/api/logistics/offline/page",
      { pageNo: 1, pageSize: 300, returnAll: true },
      {
        code: 0,
        data: {
          page: {
            pageNo: 1,
            pageSize: 300,
            rows: [{ code: "api-code", id: 7, name: "Canada Post" }],
            totalPage: 1,
            totalSize: 1,
          },
        },
      },
      [{ code: "api-code", id: 7, name: "Canada Post" }],
    ],
  ])(
    "reads typed %s with the official signed endpoint and exact body",
    async (_label, invoke, path, body, responseBody, expected) => {
      const fetchMock = vi.fn(
        async (url: RequestInfo | URL, request?: RequestInit) => {
          void url;
          void request;
          return Response.json(responseBody);
        },
      );
      const client = new JifengClient({
        credentials,
        fetch: fetchMock,
        nonce: () => "resource-nonce",
        now: () => 1_692_889_556_000,
      });

      await expect(invoke(client)).resolves.toEqual(expected);

      const [url, request] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`https://test.jfwms.com${path}`);
      expect(request?.method).toBe("POST");
      expect(JSON.parse(String(request?.body))).toEqual(body);
      const headers = new Headers(request?.headers);
      expect(headers.get("sign")).toBeTruthy();
      expect(headers.get("accessToken")).toBe(credentials.accessToken);
    },
  );

  test("refreshes an invalid access token once and replays with a fresh nonce", async () => {
    const seenAccessTokens: Array<string | null> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, request?: RequestInit) => {
      if (String(url).includes("/api/oauth/refreshToken")) {
        expect(String(url)).toContain("clientSecret=4a506ccaf37e400bac4a42d2dc5f600a");
        return new Response(
          JSON.stringify({
            code: "0",
            data: {
              accessToken: "fresh-access-token",
              expireIn: 86_400,
              refreshExpireIn: 31_536_000,
              refreshToken: "fresh-refresh-token",
              userId: 8,
            },
            message: "SUCCESS",
            requestId: "refresh-request",
          }),
        );
      }

      const headers = new Headers(request?.headers);
      seenAccessTokens.push(headers.get("accessToken"));
      if (seenAccessTokens.length === 1) {
        return new Response(
          JSON.stringify({
            code: 10002,
            data: null,
            message: "访问令牌已失效",
            requestId: "failed-request",
          }),
        );
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: { erpNo: "TZX-JF-002", status: 6 },
          message: "SUCCESS",
          requestId: "retried-request",
        }),
      );
    });
    let nonce = 13;
    const onTokensRefreshed = vi.fn();
    const client = new JifengClient({
      credentials: { ...credentials },
      fetch: fetchMock,
      nonce: () => String(++nonce),
      now: () => 1_692_889_556_000,
      onTokensRefreshed,
    });

    await expect(client.getOrder({ erpNo: "TZX-JF-002" })).resolves.toMatchObject({
      erpNo: "TZX-JF-002",
      status: 6,
    });
    expect(seenAccessTokens).toEqual([
      credentials.accessToken,
      "fresh-access-token",
    ]);
    expect(onTokensRefreshed).toHaveBeenCalledWith({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("awaits managed authentication rejection without refreshing or replaying", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      void url;
      return Response.json({
        code: 10002,
        data: null,
        message: "access token rejected",
        requestId: "managed-auth-rejection",
      });
    });
    let rejectionCompleted = false;
    const onAuthenticationRejected = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      rejectionCompleted = true;
    });
    const client = new JifengClient({
      automaticRefresh: false,
      credentials: { ...credentials },
      fetch: fetchMock,
      onAuthenticationRejected,
    });

    await expect(
      client.cancelOrder({ erpNo: "TZX-JF-MANAGED-AUTH" }),
    ).rejects.toMatchObject({
      code: "REFRESH_REQUIRED",
      requestId: "managed-auth-rejection",
      retryable: false,
    });

    expect(onAuthenticationRejected).toHaveBeenCalledTimes(1);
    expect(rejectionCompleted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://test.jfwms.com/api/order/cancel",
    );
  });

  test("rejects an incomplete refresh response instead of replaying a business request", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/oauth/refreshToken")) {
        return Response.json({
          code: 0,
          data: {
            accessToken: "fresh-access-token",
            refreshToken: "fresh-refresh-token",
            userId: 8,
          },
        });
      }
      return Response.json({ code: 10002, data: null });
    });
    const client = new JifengClient({
      credentials: { ...credentials },
      fetch: fetchMock,
    });

    await expect(
      client.getOrder({ erpNo: "TZX-JF-INCOMPLETE-REFRESH" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("signs and replays with the userId returned by token refresh", async () => {
    const seenUserIds: Array<string | null> = [];
    const seenSignatures: Array<string | null> = [];
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, request?: RequestInit) => {
        if (String(url).includes("/api/oauth/refreshToken")) {
          return Response.json({
            code: 0,
            data: {
              accessToken: "fresh-access-token",
              expireIn: 86_400,
              refreshExpireIn: 31_536_000,
              refreshToken: "fresh-refresh-token",
              userId: 99,
            },
          });
        }

        const headers = new Headers(request?.headers);
        seenUserIds.push(headers.get("userId"));
        seenSignatures.push(headers.get("sign"));
        if (seenUserIds.length === 1) {
          return Response.json({ code: 10002, data: null });
        }
        return Response.json({
          code: 0,
          data: { erpNo: "TZX-JF-NEW-USER", status: 6 },
        });
      },
    );
    const client = new JifengClient({
      credentials: { ...credentials },
      fetch: fetchMock,
      nonce: () => "refresh-user-nonce",
      now: () => 1_692_889_556_000,
    });

    await client.getOrder({ erpNo: "TZX-JF-NEW-USER" });

    expect(seenUserIds).toEqual(["8", "99"]);
    expect(seenSignatures[1]).toBe(
      signJifengRequest(credentials.clientSecret, {
        accessToken: "fresh-access-token",
        clientId: credentials.clientId,
        method: "post",
        nonce: "refresh-user-nonce",
        timestamp: "1692889556000",
        url: "/api/order/get",
        userId: "99",
      }),
    );
  });

  test("turns an aborted request into a retryable timeout without exposing credentials", async () => {
    const client = new JifengClient({
      credentials,
      fetch: (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
      timeoutMs: 5,
    });

    await expect(client.getOrder({ erpNo: "TZX-JF-TIMEOUT" })).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "极风接口请求超时",
      retryable: true,
    });
  });

  test.each([
    [50019, false],
    [50038, false],
    [50017, false],
    [50071, false],
  ])("classifies official business code %s without unsafe blind retry", async (code, retryable) => {
    const client = new JifengClient({
      credentials,
      fetch: async () =>
        new Response(
          JSON.stringify({ code, data: null, message: `official-${code}` }),
        ),
    });

    const error = await client
      .getOrder({ erpNo: "TZX-JF-CODE" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(JifengApiError);
    expect(error).toMatchObject({ code: String(code), retryable });
  });

  test.each([50018, 50060])(
    "surfaces official cancellation constraint %s without retrying",
    async (code) => {
      const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
        void url;
        return new Response(
          JSON.stringify({ code, data: null, message: `official-${code}` }),
        );
      });
      const client = new JifengClient({ credentials, fetch: fetchMock });

      await expect(
        client.cancelOrder({ erpNo: "TZX-JF-CANCEL" }),
      ).rejects.toMatchObject({ code: String(code), retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        "https://test.jfwms.com/api/order/cancel",
      );
    },
  );
});
