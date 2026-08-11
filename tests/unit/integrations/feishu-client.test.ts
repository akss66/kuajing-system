import { describe, expect, test } from "vitest";

import { FeishuClient, FeishuApiError } from "@/integrations/feishu/client";

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
      message: "飞书知识库节点不是电子表格",
    } satisfies Partial<FeishuApiError>);
  });
});
