import { z } from "zod";

import { feishuTokensMatch } from "./tokens";

const optionalString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().trim().min(1).optional(),
);

const optionalExactString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const configSchema = z
  .object({
    FEISHU_API_BASE_URL: optionalString,
    FEISHU_APP_ID: z.string().trim().min(1),
    FEISHU_APP_SECRET: z.string().trim().min(1),
    FEISHU_CARGO_SOURCE_SHEET_ID: optionalString,
    FEISHU_CARGO_SOURCE_WIKI_TOKEN: z.string().trim().min(1),
    FEISHU_CARGO_IMPORT_ENABLED: optionalExactString,
    FEISHU_CARGO_WRITES_ENABLED: optionalExactString,
    FEISHU_CARGO_TARGET_SHEET_ID: optionalString,
    FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: optionalString,
    FEISHU_INTERNAL_CHAT_ID: optionalString,
    NODE_ENV: optionalString,
  })
  .superRefine((value, ctx) => {
    const hasTargetSpreadsheet = Boolean(
      value.FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN,
    );
    const hasTargetSheet = Boolean(value.FEISHU_CARGO_TARGET_SHEET_ID);
    if (hasTargetSpreadsheet === hasTargetSheet) return;

    ctx.addIssue({
      code: "custom",
      message: "target pair mismatch",
      path: ["FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN"],
    });
    ctx.addIssue({
      code: "custom",
      message: "target pair mismatch",
      path: ["FEISHU_CARGO_TARGET_SHEET_ID"],
    });
  });

const OFFICIAL_FEISHU_API_BASE_URL = "https://open.feishu.cn";
const FEISHU_CONFIG_ERROR = "飞书集成配置不完整，请检查服务端环境变量";
const FEISHU_API_BASE_OVERRIDE_ERROR = "生产环境必须使用官方飞书 API 地址";

export type FeishuIntegrationConfig = {
  appId: string;
  appSecret: string;
  cargoImportEnabled: boolean;
  cargoWritesEnabled: boolean;
  sourceWikiToken: string;
  sourceSheetId?: string;
  targetSpreadsheetToken?: string;
  targetSheetId?: string;
  internalChatId?: string;
};

type FeishuCargoTargetConfig = {
  cargoWritesEnabled?: boolean;
  targetSheetId?: string;
  targetSpreadsheetToken?: string;
};

type FeishuCargoImportConfig = {
  cargoImportEnabled?: boolean;
};

type FeishuBotConfig = Pick<FeishuIntegrationConfig, "internalChatId">;

const feishuRuntimeVariables = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_CARGO_SOURCE_WIKI_TOKEN",
] as const;

export function hasFeishuRuntimeConfiguration(
  environment: Record<string, string | undefined> = process.env,
) {
  return feishuRuntimeVariables.every((name) => Boolean(environment[name]));
}

export function readFeishuApiBaseUrl(
  environment: Record<string, string | undefined> = process.env,
) {
  const baseUrl = environment.FEISHU_API_BASE_URL?.trim();
  const nodeEnv = environment.NODE_ENV?.trim();
  if (!baseUrl) {
    return OFFICIAL_FEISHU_API_BASE_URL;
  }
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error(FEISHU_API_BASE_OVERRIDE_ERROR);
  }
  return baseUrl.replace(/\/$/, "");
}

export function readFeishuConfig(
  environment: Record<string, string | undefined> = process.env,
): FeishuIntegrationConfig {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(FEISHU_CONFIG_ERROR);
  }

  readFeishuApiBaseUrl(environment);

  return {
    appId: parsed.data.FEISHU_APP_ID,
    appSecret: parsed.data.FEISHU_APP_SECRET,
    cargoImportEnabled: parsed.data.FEISHU_CARGO_IMPORT_ENABLED === "true",
    cargoWritesEnabled: parsed.data.FEISHU_CARGO_WRITES_ENABLED === "true",
    internalChatId: parsed.data.FEISHU_INTERNAL_CHAT_ID,
    sourceSheetId: parsed.data.FEISHU_CARGO_SOURCE_SHEET_ID,
    sourceWikiToken: parsed.data.FEISHU_CARGO_SOURCE_WIKI_TOKEN,
    targetSheetId: parsed.data.FEISHU_CARGO_TARGET_SHEET_ID,
    targetSpreadsheetToken: parsed.data.FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN,
  };
}

export function canImportFeishuCargo(config: FeishuCargoImportConfig) {
  return config.cargoImportEnabled === true;
}

export function hasFeishuCargoTargetConfig(config: FeishuCargoTargetConfig) {
  return Boolean(config.targetSpreadsheetToken && config.targetSheetId);
}

export function canWriteFeishuCargo(config: FeishuCargoTargetConfig) {
  return (
    hasFeishuCargoTargetConfig(config) &&
    "cargoWritesEnabled" in config &&
    config.cargoWritesEnabled === true
  );
}

export function canProcessFeishuBot(config: FeishuBotConfig) {
  return Boolean(config.internalChatId);
}

export function assertSafeCargoTarget(
  config: FeishuIntegrationConfig,
  resolvedSourceSpreadsheetToken: string,
) {
  if (!config.targetSpreadsheetToken || !config.targetSheetId) {
    throw new Error(FEISHU_CONFIG_ERROR);
  }

  if (
    feishuTokensMatch(
      resolvedSourceSpreadsheetToken,
      config.targetSpreadsheetToken,
    )
  ) {
    throw new Error("飞书源货盘与目标测试表不能是同一电子表格");
  }
}
