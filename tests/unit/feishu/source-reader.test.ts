import { describe, expect, test, vi } from "vitest";

import {
  readFeishuSourceSnapshot,
  type FeishuSourcePort,
} from "@/modules/feishu/source-reader";

function sourceClient(values: unknown[][]) {
  return {
    downloadMedia: vi.fn(),
    listSheets: vi.fn(async () => [
      { index: 0, sheetId: "sheet-primary", title: "货盘" },
    ]),
    readRangeDetails: vi.fn(async (input: { range: string }) => ({
      range: input.range,
      revision: 12,
      values,
    })),
    resolveWikiSpreadsheet: vi.fn(async () => ({
      spreadsheetToken: "source-spreadsheet-token",
    })),
  } satisfies FeishuSourcePort;
}

describe("Feishu source reader", () => {
  test("fails closed when source data extends beyond the supported row boundary", async () => {
    const client = sourceClient(
      Array.from({ length: 501 }, (_, index) => [`row-${index + 1}`]),
    );

    await expect(
      readFeishuSourceSnapshot({
        client,
        config: {
          sourceSheetId: "sheet-primary",
          sourceWikiToken: "wiki-source-token",
        },
      }),
    ).rejects.toThrow("飞书源货盘超过 500 行");

    expect(client.readRangeDetails).toHaveBeenCalledWith({
      range: "sheet-primary!A1:Z501",
      spreadsheetToken: "source-spreadsheet-token",
    });
  });
});
