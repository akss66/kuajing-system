import { describe, expect, test } from "vitest";

import { FeishuApiError, FeishuClient } from "@/integrations/feishu/client";

describe("Feishu API client", () => {
  test("gets a tenant token, resolves a wiki sheet, writes values and sends a group message", async () => {
    const calls: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
    const responses = [
      { code: 0, expire: 7200, tenant_access_token: "tenant-token" },
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

  test("rejects non-sheet wiki nodes and sanitizes Feishu API errors", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("tenant_access_token")
              ? { code: 0, expire: 7200, tenant_access_token: "tenant-token" }
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
      retryable: false,
    } satisfies Partial<FeishuApiError>);
  });

  test("reads detailed ranges with revision metadata and raw rich values", async () => {
    const calls: Array<{ headers: Headers; url: string }> = [];
    const responses = [
      { code: 0, expire: 7200, tenant_access_token: "tenant-token" },
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

  test("downloads media bytes without json parsing and returns a safe suggested file name", async () => {
    const binary = Uint8Array.from([137, 80, 78, 71]);
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(
            JSON.stringify({
              code: 0,
              expire: 7200,
              tenant_access_token: "tenant-token",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
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

  test("treats media download permission failures as permanent and sanitized", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(
            JSON.stringify({
              code: 0,
              expire: 7200,
              tenant_access_token: "tenant-token",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        return new Response("forbidden", { status: 403 });
      },
    });

    await expect(client.downloadMedia("img-secret-token")).rejects.toMatchObject({
      code: "HTTP_403",
      retryable: false,
    } satisfies Partial<FeishuApiError>);
    await client.downloadMedia("img-secret-token").catch((error: unknown) => {
      expect(error).toBeInstanceOf(FeishuApiError);
      expect(String(error)).not.toContain("img-secret-token");
      expect(String(error)).not.toContain("tenant-token");
    });
  });

  test("rejects media responses that declare a body larger than eight mebibytes", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(
            JSON.stringify({
              code: 0,
              expire: 7200,
              tenant_access_token: "tenant-token",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: {
            "Content-Length": String(8 * 1024 * 1024 + 1),
            "Content-Type": "image/jpeg",
          },
          status: 200,
        });
      },
    });

    await expect(client.downloadMedia("oversized-file")).rejects.toMatchObject({
      code: "MEDIA_TOO_LARGE",
      retryable: false,
    } satisfies Partial<FeishuApiError>);
  });

  test("rejects streamed media once the buffered size exceeds eight mebibytes", async () => {
    const client = new FeishuClient({
      appId: "cli-app",
      appSecret: "app-secret",
      fetch: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return new Response(
            JSON.stringify({
              code: 0,
              expire: 7200,
              tenant_access_token: "tenant-token",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
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

  test("writes images, styles, dimensions, and filters using the documented payload shapes", async () => {
    const calls: Array<{ body: unknown; method: string; url: string }> = [];
    const responses = [
      { code: 0, expire: 7200, tenant_access_token: "tenant-token" },
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
