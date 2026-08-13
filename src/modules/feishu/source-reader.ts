import { createHash } from "node:crypto";

import type { FeishuIntegrationConfig } from "@/integrations/feishu/config";

export type FeishuSourcePort = {
  resolveWikiSpreadsheet(
    wikiToken: string,
  ): Promise<{ spreadsheetToken: string }>;
  listSheets(spreadsheetToken: string): Promise<
    Array<{ index: number; sheetId: string; title: string }>
  >;
  readRangeDetails(input: {
    range: string;
    spreadsheetToken: string;
  }): Promise<{ range: string; revision: number; values: unknown[][] }>;
  downloadMedia(fileToken: string): Promise<{
    bytes: Uint8Array;
    contentType: string;
    fileName: null | string;
  }>;
};

export type FeishuSourceSheet = {
  index: number;
  sheetId: string;
  title: string;
};

export type FeishuSourceSelectionRequired = {
  sheetOptions: FeishuSourceSheet[];
  status: "SOURCE_SHEET_SELECTION_REQUIRED";
};

export type FeishuSourceSnapshot = {
  range: string;
  revision: number;
  selectedSheet: FeishuSourceSheet;
  spreadsheetToken: string;
  spreadsheetTokenHash: string;
  values: unknown[][];
};

export type FeishuSourceSheetDiscovery =
  | {
      sheetOptions: FeishuSourceSheet[];
      status: "READY";
    }
  | {
      message: string;
      sheetOptions: FeishuSourceSheet[];
      status: "ERROR";
    };

type ResolveSourceSheetResult =
  | FeishuSourceSelectionRequired
  | {
      selectedSheet: FeishuSourceSheet;
      spreadsheetToken: string;
      spreadsheetTokenHash: string;
    };

function hashSpreadsheetToken(spreadsheetToken: string) {
  return createHash("sha256").update(spreadsheetToken).digest("hex");
}

export async function discoverFeishuSourceSheets(input: {
  client: FeishuSourcePort;
  config: Pick<FeishuIntegrationConfig, "sourceWikiToken">;
}): Promise<FeishuSourceSheetDiscovery> {
  try {
    const { spreadsheetToken } = await input.client.resolveWikiSpreadsheet(
      input.config.sourceWikiToken,
    );
    const sheetOptions = await input.client.listSheets(spreadsheetToken);

    if (sheetOptions.length === 0) {
      return {
        message: "源货盘可访问，但未找到任何工作表。",
        sheetOptions: [],
        status: "ERROR",
      };
    }

    return {
      sheetOptions,
      status: "READY",
    };
  } catch (error) {
    return {
      message:
        error instanceof Error
          ? error.message
          : "暂时无法读取源工作表列表，请先验证只读连接后重试。",
      sheetOptions: [],
      status: "ERROR",
    };
  }
}

export async function resolveFeishuSourceSheet(input: {
  client: FeishuSourcePort;
  config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
}): Promise<ResolveSourceSheetResult> {
  const { spreadsheetToken } = await input.client.resolveWikiSpreadsheet(
    input.config.sourceWikiToken,
  );
  const sheets = await input.client.listSheets(spreadsheetToken);

  if (sheets.length === 0) {
    throw new Error("Feishu source spreadsheet has no sheets");
  }

  const configuredSheetId = input.config.sourceSheetId?.trim();
  if (!configuredSheetId) {
    if (sheets.length > 1) {
      return {
        sheetOptions: sheets,
        status: "SOURCE_SHEET_SELECTION_REQUIRED",
      };
    }

    return {
      selectedSheet: sheets[0],
      spreadsheetToken,
      spreadsheetTokenHash: hashSpreadsheetToken(spreadsheetToken),
    };
  }

  const selectedSheet = sheets.find((sheet) => sheet.sheetId === configuredSheetId);
  if (!selectedSheet) {
    throw new Error("Configured Feishu source sheet was not found");
  }

  return {
    selectedSheet,
    spreadsheetToken,
    spreadsheetTokenHash: hashSpreadsheetToken(spreadsheetToken),
  };
}

export async function readFeishuSourceSnapshot(input: {
  client: FeishuSourcePort;
  config: Pick<FeishuIntegrationConfig, "sourceSheetId" | "sourceWikiToken">;
}): Promise<FeishuSourceSelectionRequired | FeishuSourceSnapshot> {
  const resolved = await resolveFeishuSourceSheet(input);
  if ("status" in resolved) {
    return resolved;
  }

  const range = `${resolved.selectedSheet.sheetId}!A1:Z500`;
  const details = await input.client.readRangeDetails({
    range,
    spreadsheetToken: resolved.spreadsheetToken,
  });

  return {
    range,
    revision: details.revision,
    selectedSheet: resolved.selectedSheet,
    spreadsheetToken: resolved.spreadsheetToken,
    spreadsheetTokenHash: resolved.spreadsheetTokenHash,
    values: details.values,
  };
}
