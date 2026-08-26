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

  test("rejects an order detail that does not match the requested ERP number", async () => {
    const client = new JifengClient({
      credentials,
      fetch: vi.fn(async () =>
        Response.json({
          code: 0,
          data: {
            erpNo: "TZX-JF-WRONG-ORDER",
            status: 7,
            trackingNo: "CP-WRONG-ORDER",
          },
          requestId: "mismatched-order-response",
        }),
      ),
    });

    await expect(
      client.getOrder({ erpNo: "TZX-JF-EXPECTED-ORDER" }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      requestId: "mismatched-order-response",
      retryable: true,
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

  test("queries Jifeng order by platform order number through the documented page endpoint", async () => {
    const fetchMock = vi.fn<
      (url: RequestInfo | URL, request?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        code: 0,
        data: {
          pageNo: 1,
          pageSize: 300,
          rows: [
            {
              currency: "CAD",
              erpNo: "TZX-PLAT-001",
              logisticsFee: 5.2,
              orderNo: "TEMU-PLAT-001",
              platformOrderNo: "TEMU-PLAT-001",
              status: 6,
              trackingNo: "T001PLAT",
            },
          ],
          totalPage: 1,
          totalSize: 1,
        },
        message: "SUCCESS",
        requestId: "platform-query",
      }),
    );
    const client = new JifengClient({
      credentials,
      fetch: fetchMock,
      nonce: () => "platform-query",
      now: () => 1_692_889_556_000,
    });

    await expect(
      client.getOrder({ platformOrderNo: "TEMU-PLAT-001" }),
    ).resolves.toMatchObject({
      erpNo: "TZX-PLAT-001",
      orderNo: "TEMU-PLAT-001",
      platformOrderNo: "TEMU-PLAT-001",
      status: 6,
    });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://test.jfwms.com/api/order/page");
    expect(JSON.parse(String(request?.body))).toEqual({
      pageNo: 1,
      pageSize: 300,
      platformOrderNo: "TEMU-PLAT-001",
    });
  });

  test("keeps scanning later pages until it finds the exact platform order number", async () => {
    const fetchMock = vi.fn<
      (url: RequestInfo | URL, request?: RequestInit) => Promise<Response>
    >(async (_url, request) => {
      const { pageNo } = JSON.parse(String(request?.body)) as { pageNo: number };
      return Response.json({
        code: 0,
        data: pageNo === 1
          ? {
              pageNo: 1,
              pageSize: 300,
              rows: [{
                erpNo: "OTHER-ERP-001",
                platformOrderNo: "TEMU-OTHER-001",
                status: 2,
              }],
              totalPage: 2,
              totalSize: 301,
            }
          : {
              pageNo: 2,
              pageSize: 300,
              rows: [{
                erpNo: "TZX-PLAT-002",
                orderNo: "TEMU-PLAT-002",
                platformOrderNo: "TEMU-PLAT-002",
                status: 2,
              }],
              totalPage: 2,
              totalSize: 301,
            },
        message: "SUCCESS",
        requestId: `platform-query-${pageNo}`,
      });
    });
    const client = new JifengClient({
      credentials,
      fetch: fetchMock,
      nonce: () => "platform-query-pagination",
      now: () => 1_692_889_556_000,
    });

    await expect(
      client.getOrder({ platformOrderNo: "TEMU-PLAT-002" }),
    ).resolves.toMatchObject({
      erpNo: "TZX-PLAT-002",
      orderNo: "TEMU-PLAT-002",
      platformOrderNo: "TEMU-PLAT-002",
      status: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).pageNo))
      .toEqual([1, 2]);
  });

  test("stops safely when Jifeng reports an unreasonable number of order pages", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      code: 0,
      data: {
        pageNo: 1,
        pageSize: 300,
        rows: [],
        totalPage: 100_000,
        totalSize: 30_000_000,
      },
      message: "SUCCESS",
      requestId: "platform-query-unbounded",
    }));
    const client = new JifengClient({
      credentials,
      fetch: fetchMock,
    });

    await expect(
      client.getOrder({ platformOrderNo: "TEMU-UNBOUNDED" }),
    ).rejects.toMatchObject({
      code: "PAGINATION_LIMIT_EXCEEDED",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reports a missing platform order when the documented page query returns no exact row", async () => {
    const client = new JifengClient({
      credentials,
      fetch: async () => Response.json({
        code: 0,
        data: {
          pageNo: 1,
          pageSize: 300,
          rows: [],
          totalPage: 0,
          totalSize: 0,
        },
        message: "SUCCESS",
      }),
    });

    await expect(
      client.getOrder({ platformOrderNo: "TEMU-MISSING" }),
    ).rejects.toMatchObject({ code: "50017", retryable: false });
  });

  test("rejects ambiguous exact platform order matches instead of binding an arbitrary order", async () => {
    const client = new JifengClient({
      credentials,
      fetch: async () => Response.json({
        code: 0,
        data: {
          pageNo: 1,
          pageSize: 300,
          rows: [
            { erpNo: "ERP-A", platformOrderNo: "TEMU-DUPLICATE", status: 2 },
            { erpNo: "ERP-B", platformOrderNo: "TEMU-DUPLICATE", status: 2 },
          ],
          totalPage: 1,
          totalSize: 2,
        },
        message: "SUCCESS",
      }),
    });

    await expect(
      client.getOrder({ platformOrderNo: "TEMU-DUPLICATE" }),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_PLATFORM_ORDER",
      retryable: false,
    });
  });
});
