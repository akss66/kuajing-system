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
    FEISHU_CATALOG_MIRROR_CUTOFF_AT: optionalExactString,
    FEISHU_CATALOG_MIRROR_ENABLED: optionalExactString,
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
  catalogMirrorCutoffAt?: string;
  catalogMirrorEnabled?: boolean;
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

type FeishuCatalogMirrorConfig = {
  catalogMirrorCutoffAt?: string;
  catalogMirrorEnabled?: boolean;
};

export type FeishuCatalogMirrorPhase =
  | "DISABLED"
  | "MISCONFIGURED"
  | "RETIRED"
  | "TRANSITION";

export type FeishuCatalogMirrorAvailability = {
  cutoffAt: string | null;
  enabled: boolean;
  phase: FeishuCatalogMirrorPhase;
};

const ISO_TIMESTAMP_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/;

function parseIsoTimestampWithZone(value: string) {
  const match = ISO_TIMESTAMP_WITH_ZONE.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondsText, zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number(millisecondsText ?? "0");
  const zoneSign = zone === "Z" || zone.startsWith("+") ? 1 : -1;
  const zoneHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (zoneHours > 23 || zoneMinutes > 59) return null;

  const offsetMinutes = zoneSign * (zoneHours * 60 + zoneMinutes);
  const localTimestamp = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    milliseconds,
  );
  const normalizedLocal = new Date(localTimestamp);
  if (
    normalizedLocal.getUTCFullYear() !== year ||
    normalizedLocal.getUTCMonth() !== month - 1 ||
    normalizedLocal.getUTCDate() !== day ||
    normalizedLocal.getUTCHours() !== hour ||
    normalizedLocal.getUTCMinutes() !== minute ||
    normalizedLocal.getUTCSeconds() !== second ||
    normalizedLocal.getUTCMilliseconds() !== milliseconds
  ) {
    return null;
  }

  return localTimestamp - offsetMinutes * 60_000;
}

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
    catalogMirrorCutoffAt: parsed.data.FEISHU_CATALOG_MIRROR_CUTOFF_AT,
    catalogMirrorEnabled:
      parsed.data.FEISHU_CATALOG_MIRROR_ENABLED === "true",
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

export function getFeishuCatalogMirrorAvailability(
  config: FeishuCatalogMirrorConfig,
  now = new Date(),
): FeishuCatalogMirrorAvailability {
  if (config.catalogMirrorEnabled !== true) {
    return { cutoffAt: null, enabled: false, phase: "DISABLED" };
  }

  const cutoffAt = config.catalogMirrorCutoffAt;
  if (!cutoffAt) {
    return { cutoffAt: null, enabled: false, phase: "MISCONFIGURED" };
  }

  const cutoffTimestamp = parseIsoTimestampWithZone(cutoffAt);
  if (cutoffTimestamp === null || !Number.isFinite(now.getTime())) {
    return { cutoffAt: null, enabled: false, phase: "MISCONFIGURED" };
  }

  if (now.getTime() >= cutoffTimestamp) {
    return { cutoffAt, enabled: false, phase: "RETIRED" };
  }

  return { cutoffAt, enabled: true, phase: "TRANSITION" };
}

export function canMirrorFeishuCatalog(
  config: FeishuCatalogMirrorConfig,
  now = new Date(),
) {
  return getFeishuCatalogMirrorAvailability(config, now).enabled;
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
