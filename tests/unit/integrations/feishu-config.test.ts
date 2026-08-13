import { describe, expect, test } from "vitest";

import {
  assertSafeCargoTarget,
  canProcessFeishuBot,
  hasFeishuCargoTargetConfig,
  canWriteFeishuCargo,
  hasFeishuRuntimeConfiguration,
  readFeishuApiBaseUrl,
  readFeishuConfig,
} from "@/integrations/feishu/config";

describe("Feishu integration config", () => {
  test("accepts paired source and target values while leaving bot chat optional", () => {
    const config = readFeishuConfig({
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
      FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "spreadsheet-target",
      FEISHU_CARGO_TARGET_SHEET_ID: "sheet-target",
    });

    expect(config).toEqual({
      appId: "app",
      appSecret: "secret",
      cargoWritesEnabled: false,
      internalChatId: undefined,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source",
      targetSheetId: "sheet-target",
      targetSpreadsheetToken: "spreadsheet-target",
    });
    expect(hasFeishuCargoTargetConfig(config)).toBe(true);
    expect(canWriteFeishuCargo(config)).toBe(false);
    expect(canProcessFeishuBot(config)).toBe(false);
  });

  test("accepts source-only configuration for preflight while disabling the writer", () => {
    const config = readFeishuConfig({
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
    });

    expect(config).toEqual({
      appId: "app",
      appSecret: "secret",
      cargoWritesEnabled: false,
      internalChatId: undefined,
      sourceSheetId: undefined,
      sourceWikiToken: "wiki-source",
      targetSheetId: undefined,
      targetSpreadsheetToken: undefined,
    });
    expect(hasFeishuCargoTargetConfig(config)).toBe(false);
    expect(canWriteFeishuCargo(config)).toBe(false);
    expect(canProcessFeishuBot(config)).toBe(false);
  });

  test("enables cargo writes only for the exact true flag", () => {
    const targetConfig = {
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
      FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "spreadsheet-target",
      FEISHU_CARGO_TARGET_SHEET_ID: "sheet-target",
    };

    expect(
      canWriteFeishuCargo(
        readFeishuConfig({
          ...targetConfig,
          FEISHU_CARGO_WRITES_ENABLED: "true",
        }),
      ),
    ).toBe(true);

    for (const malformed of [undefined, "", "TRUE", " true ", "1", "false"]) {
      expect(
        canWriteFeishuCargo(
          readFeishuConfig({
            ...targetConfig,
            FEISHU_CARGO_WRITES_ENABLED: malformed,
          }),
        ),
      ).toBe(false);
    }
  });

  test("rejects partial target configuration", () => {
    expect(() =>
      readFeishuConfig({
        FEISHU_APP_ID: "app",
        FEISHU_APP_SECRET: "secret",
        FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
        FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "spreadsheet-target",
      }),
    ).toThrowError("飞书集成配置不完整，请检查服务端环境变量");

    expect(() =>
      readFeishuConfig({
        FEISHU_APP_ID: "app",
        FEISHU_APP_SECRET: "secret",
        FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
        FEISHU_CARGO_TARGET_SHEET_ID: "sheet-target",
      }),
    ).toThrowError("飞书集成配置不完整，请检查服务端环境变量");
  });

  test("accepts a bot chat id when notifications are enabled", () => {
    const config = readFeishuConfig({
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
      FEISHU_INTERNAL_CHAT_ID: "chat-1",
    });

    expect(config.internalChatId).toBe("chat-1");
    expect(canProcessFeishuBot(config)).toBe(true);
  });

  test("allows API base overrides only for explicit development and test environments", () => {
    expect(
      readFeishuApiBaseUrl({
        NODE_ENV: "production",
      }),
    ).toBe("https://open.feishu.cn");

    for (const nodeEnv of [undefined, "prod", "production", "staging"]) {
      expect(() =>
        readFeishuApiBaseUrl({
          FEISHU_API_BASE_URL: "http://127.0.0.1:4010/",
          NODE_ENV: nodeEnv,
        }),
      ).toThrowError("生产环境必须使用官方飞书 API 地址");
    }

    expect(
      readFeishuApiBaseUrl({
        FEISHU_API_BASE_URL: "http://127.0.0.1:4010/",
        NODE_ENV: "development",
      }),
    ).toBe("http://127.0.0.1:4010");

    expect(
      readFeishuApiBaseUrl({
        FEISHU_API_BASE_URL: "http://127.0.0.1:4010/",
        NODE_ENV: "test",
      }),
    ).toBe("http://127.0.0.1:4010");

    expect(
      hasFeishuRuntimeConfiguration({
        FEISHU_API_BASE_URL: "http://127.0.0.1:4010/",
      }),
    ).toBe(false);
  });

  test("does not treat the rollout gate by itself as runtime Feishu configuration", () => {
    expect(
      hasFeishuRuntimeConfiguration({
        FEISHU_CARGO_WRITES_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      hasFeishuRuntimeConfiguration({
        FEISHU_CARGO_WRITES_ENABLED: "true",
      }),
    ).toBe(false);
  });

  test("rejects using the resolved source spreadsheet as the cargo target", () => {
    const config = readFeishuConfig({
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
      FEISHU_CARGO_WRITES_ENABLED: "true",
      FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "same-token",
      FEISHU_CARGO_TARGET_SHEET_ID: "target-sheet",
    });

    expect(() => assertSafeCargoTarget(config, "same-token")).toThrowError(
      "飞书源货盘与目标测试表不能是同一电子表格",
    );
  });
});
