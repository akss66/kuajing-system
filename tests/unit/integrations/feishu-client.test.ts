import { describe, expect, test } from "vitest";

import { FeishuApiError, FeishuClient } from "@/integrations/feishu/client";

const FEISHU_NON_SHEET_MESSAGE =
  "\u98de\u4e66\u77e5\u8bc6\u5e93\u8282\u70b9\u4e0d\u662f\u7535\u5b50\u8868\u683c";
const FEISHU_INVALID_RESPONSE_MESSAGE =
  "\u98de\u4e66\u63a5\u53e3\u54cd\u5e94\u683c\u5f0f\u65e0\u6548";
const FEISHU_TOKEN_FAILURE_MESSAGE =
  "\u98de\u4e66\u5e94\u7528\u8bbf\u95ee\u51ed\u8bc1\u83b7\u53d6\u5931\u8d25";
const FEISHU_TIMEOUT_MESSAGE =
  "\u98de\u4e66\u63a5\u53e3\u8bf7\u6c42\u8d85\u65f6";

function feishuHttpMessage(status: number) {
  return `\u98de\u4e66\u63a5\u53e3\u7f51\u7edc\u54cd\u5e94\u5f02\u5e38\uff08${status}\uff09`;
}

function tokenResponse() {
  return { code: 0, expire: 7200, tenant_access_token: "tenant-token" };
}

describe("Feishu API client", () => {
  test("gets a tenant token, resolves a wiki sheet, writes values and sends a group message", async () => {
    const calls: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
    const responses = [
      tokenResponse(),
      {
        code: 0,
        data: { node: { obj_token: "spreadsheet-token", obj_type: "sheet" } },
        msg: "success",
      },
      {
        code: 0,
        data: { sheets: [{ index: 0, sheet_id: "sheet-1", title: "货盘" }] },
        msg: "success",
      },
      {
        code: 0,
        data: { updatedCells: 26, updatedRange: "sheet-1!A1:M2" },
        msg: "success",
      },
      { code: 0, data: { message_id: "om-message-1" }, msg: "success" },
    ];
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          url: String(url),
        });
        return new Response(JSON.stringify(responses.shift()), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
      now: () => Date.parse("2026-08-12T05:00:00.000Z"),
    });

    const sheet = await client.resolveWikiSpreadsheet("wiki-node-token");
    const sheets = await client.listSheets(sheet.spreadsheetToken);
    await client.writeRange({
      range: "sheet-1!A1:M2",
      spreadsheetToken: sheet.spreadsheetToken,
      values: [["序号", "SKU"], [1, "TZX-001"]],
    });
    await client.sendTextMessage({ chatId: "oc-chat", text: "库存预警：TZX-001" });

    expect(sheet).toEqual({ spreadsheetToken: "spreadsheet-token" });
    expect(sheets).toEqual([{ index: 0, sheetId: "sheet-1", title: "货盘" }]);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"],
      ["GET", "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wiki-node-token"],
      ["GET", "https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/spreadsheet-token/sheets/query"],
      ["PUT", "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/spreadsheet-token/values"],
      ["POST", "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"],
    ]);
    expect(calls[1].headers.get("Authorization")).toBe("Bearer tenant-token");
    expect(calls[3].body).toEqual({
      valueRange: {
        range: "sheet-1!A1:M2",
        values: [["序号", "SKU"], [1, "TZX-001"]],
      },
    });
    expect(calls[4].body).toEqual({
      content: JSON.stringify({ text: "库存预警：TZX-001" }),
      msg_type: "text",
      receive_id: "oc-chat",
    });
  });

  test("rejects non-sheet wiki nodes with the stable caller-facing message", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("tenant_access_token")
              ? tokenResponse()
              : {
                  code: 0,
                  data: { node: { obj_token: "doc-token", obj_type: "docx" } },
                  msg: "success",
                },
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    });

    await expect(client.resolveWikiSpreadsheet("wiki-doc")).rejects.toMatchObject({
      code: "WIKI_NODE_NOT_SHEET",
      message: FEISHU_NON_SHEET_MESSAGE,
      retryable: false,
    } satisfies Partial<FeishuApiError>);
  });

  test("reads detailed ranges with revision metadata and raw rich values", async () => {
    const calls: Array<{ headers: Headers; url: string }> = [];
    const responses = [
      tokenResponse(),
      {
        code: 0,
        data: {
          revision: 112,
          spreadsheetToken: "source-token",
          valueRange: {
            majorDimension: "ROWS",
            range: "sheet-1!A1:Z500",
            revision: 112,
            values: [
              [
                { text: "SKU-001", type: "text" },
                {
                  mentionType: "User",
                  text: "@Alice",
                  type: "mention",
                  userInfo: { openId: "ou_123" },
                },
              ],
              [123, null],
            ],
          },
        },
        msg: "success",
      },
    ];
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url, init) => {
        calls.push({
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(JSON.stringify(responses.shift()), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
    });

    await expect(
      client.readRangeDetails({
        range: "sheet-1!A1:Z500",
        spreadsheetToken: "source-token",
      }),
    ).resolves.toEqual({
      range: "sheet-1!A1:Z500",
      revision: 112,
      values: [
        [
          { text: "SKU-001", type: "text" },
          {
            mentionType: "User",
            text: "@Alice",
            type: "mention",
            userInfo: { openId: "ou_123" },
          },
        ],
        [123, null],
      ],
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/source-token/values/sheet-1!A1%3AZ500",
    ]);
    expect(calls[1].headers.get("Authorization")).toBe("Bearer tenant-token");
  });

  test("rejects detailed range responses that omit range or revision instead of fabricating values", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("tenant_access_token")
              ? tokenResponse()
              : {
                  code: 0,
                  data: {
                    valueRange: {
                      values: [["SKU-001"]],
                    },
                  },
                  msg: "success",
                },
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    });

    await expect(
      client.readRangeDetails({
        range: "sheet-1!A1:A1",
        spreadsheetToken: "source-token",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: FEISHU_INVALID_RESPONSE_MESSAGE,
      retryable: true,
    } satisfies Partial<FeishuApiError>);
  });

  test("rejects non-json API bodies with a stable invalid-response error", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response("<html>not json</html>", {
          headers: { "Content-Type": "text/html" },
          status: 200,
        });
      },
    });

    await expect(
      client.readRangeDetails({
        range: "sheet-1!A1:A1",
        spreadsheetToken: "source-token",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: FEISHU_INVALID_RESPONSE_MESSAGE,
      retryable: true,
    } satisfies Partial<FeishuApiError>);
  });

  test("returns the stable token acquisition failure when the auth response is not json", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async () =>
        new Response("nope", {
          headers: { "Content-Type": "text/plain" },
          status: 200,
        }),
    });

    await expect(client.listSheets("spreadsheet-token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: FEISHU_TOKEN_FAILURE_MESSAGE,
      retryable: true,
    } satisfies Partial<FeishuApiError>);
  });

  test("downloads media bytes without json parsing and returns a safe suggested file name", async () => {
    const binary = Uint8Array.from([137, 80, 78, 71]);
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response(binary, {
          headers: {
            "Content-Disposition": "attachment; filename=\"..\\\\stock-image.png\"",
            "Content-Type": "image/png",
          },
          status: 200,
        });
      },
    });

    await expect(client.downloadMedia("file-token-1")).resolves.toEqual({
      bytes: binary,
      contentType: "image/png",
      fileName: "stock-image.png",
    });
  });

  test("treats media download permission failures as permanent, sanitized, and caller-stable", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response("forbidden", { status: 403 });
      },
    });

    await expect(client.downloadMedia("img-secret-token")).rejects.toMatchObject({
      code: "HTTP_403",
      message: feishuHttpMessage(403),
      retryable: false,
    } satisfies Partial<FeishuApiError>);
    await client.downloadMedia("img-secret-token").catch((error: unknown) => {
      expect(error).toBeInstanceOf(FeishuApiError);
      expect(String(error)).not.toContain("img-secret-token");
      expect(String(error)).not.toContain("tenant-token");
    });
  });

  test("treats media unauthorized responses as permanent and caller-stable", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response("unauthorized", { status: 401 });
      },
    });

    await expect(client.downloadMedia("img-secret-token")).rejects.toMatchObject({
      code: "HTTP_401",
      message: feishuHttpMessage(401),
      retryable: false,
    } satisfies Partial<FeishuApiError>);
  });

  test("rejects media responses that declare a body larger than eight mebibytes and cancels the body", async () => {
    let canceled = false;
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.from([1, 2, 3]));
            },
            cancel() {
              canceled = true;
            },
          }),
          {
            headers: {
              "Content-Length": String(8 * 1024 * 1024 + 1),
              "Content-Type": "image/jpeg",
            },
            status: 200,
          },
        );
      },
    });

    await expect(client.downloadMedia("oversized-file")).rejects.toMatchObject({
      code: "MEDIA_TOO_LARGE",
      retryable: false,
    } satisfies Partial<FeishuApiError>);
    expect(canceled).toBe(true);
  });

  test("rejects streamed media once the buffered size exceeds eight mebibytes", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024));
              controller.enqueue(Uint8Array.from([1]));
              controller.close();
            },
          }),
          {
            headers: { "Content-Type": "image/jpeg" },
            status: 200,
          },
        );
      },
    });

    await expect(client.downloadMedia("streamed-file")).rejects.toMatchObject({
      code: "MEDIA_TOO_LARGE",
      retryable: false,
    } satisfies Partial<FeishuApiError>);
  });

  test("times out stalled media bodies after headers using the shared request timeout", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      timeoutMs: 20,
      fetch: async (url, init) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(JSON.stringify(tokenResponse()), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const signal = init?.signal;
              if (!(signal instanceof AbortSignal)) return;
              if (signal.aborted) {
                controller.error(new DOMException("Aborted", "AbortError"));
                return;
              }
              signal.addEventListener(
                "abort",
                () => controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          {
            headers: { "Content-Type": "image/jpeg" },
            status: 200,
          },
        );
      },
    });

    await expect(client.downloadMedia("stalling-file")).rejects.toMatchObject({
      code: "TIMEOUT",
      message: FEISHU_TIMEOUT_MESSAGE,
      retryable: true,
    } satisfies Partial<FeishuApiError>);
  });

  test("times out auth or json transport requests with the stable timeout code", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      timeoutMs: 20,
      fetch: async () => await new Promise<Response>(() => {}),
    });

    await expect(client.listSheets("spreadsheet-token")).rejects.toMatchObject({
      code: "TIMEOUT",
      message: FEISHU_TIMEOUT_MESSAGE,
      retryable: true,
    } satisfies Partial<FeishuApiError>);
  });

  test("writes images, styles, dimensions, and filters using the documented payload shapes", async () => {
    const calls: Array<{ body: unknown; method: string; url: string }> = [];
    const responses = [
      tokenResponse(),
      {
        code: 0,
        data: {
          revision: 80,
          spreadsheetToken: "target-token",
          updatedRange: "sheet-9!C2:C2",
        },
        msg: "success",
      },
      {
        code: 0,
        data: { revision: 90, totalUpdatedCells: 13 },
        msg: "success",
      },
      { code: 0, data: {}, msg: "Success" },
      { code: 0, data: {}, msg: "success" },
    ];
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? "GET",
          url: String(url),
        });
        return new Response(JSON.stringify(responses.shift()), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
    });

    await client.writeImage({
      bytes: Uint8Array.from([1, 2, 3, 4]),
      fileName: "cargo.jpg",
      range: "sheet-9!C2:C2",
      spreadsheetToken: "target-token",
    });
    await client.setRangeStyle({
      data: [
        {
          ranges: ["sheet-9!A1:M1"],
          style: { font: { bold: true }, hAlign: 1 },
        },
      ],
      spreadsheetToken: "target-token",
    });
    await client.updateDimension({
      dimension: {
        endIndex: 10,
        majorDimension: "ROWS",
        sheetId: "sheet-9",
        startIndex: 2,
      },
      dimensionProperties: { fixedSize: 120, visible: true },
      spreadsheetToken: "target-token",
    });
    await client.createFilter({
      col: "A",
      condition: {
        compare_type: "contains",
        expected: ["SKU"],
        filter_type: "text",
      },
      range: "sheet-9!A1:M75",
      sheetId: "sheet-9",
      spreadsheetToken: "target-token",
    });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"],
      ["POST", "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/target-token/values_image"],
      ["PUT", "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/target-token/styles_batch_update"],
      ["PUT", "https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/target-token/dimension_range"],
      ["POST", "https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/target-token/sheets/sheet-9/filter"],
    ]);
    expect(calls[1].body).toEqual({
      image: [1, 2, 3, 4],
      name: "cargo.jpg",
      range: "sheet-9!C2:C2",
    });
    expect(calls[2].body).toEqual({
      data: [
        {
          ranges: ["sheet-9!A1:M1"],
          style: { font: { bold: true }, hAlign: 1 },
        },
      ],
    });
    expect(calls[3].body).toEqual({
      dimension: {
        endIndex: 10,
        majorDimension: "ROWS",
        sheetId: "sheet-9",
        startIndex: 2,
      },
      dimensionProperties: { fixedSize: 120, visible: true },
    });
    expect(calls[4].body).toEqual({
      col: "A",
      condition: {
        compare_type: "contains",
        expected: ["SKU"],
        filter_type: "text",
      },
      range: "sheet-9!A1:M75",
    });
  });
});
