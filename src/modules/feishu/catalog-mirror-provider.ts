import { FeishuClient } from "@/integrations/feishu/client";
import {
  canMirrorFeishuCatalog,
  readFeishuApiBaseUrl,
  readFeishuConfig,
} from "@/integrations/feishu/config";

import { createCatalogFieldRefreshService } from "./catalog-field-refresh";
import { processCatalogMirrorOutbox } from "./catalog-mirror-outbox";

export async function runFeishuCatalogMirrorCycle() {
  const config = readFeishuConfig();
  if (!canMirrorFeishuCatalog(config)) {
    return { completed: 0, enabled: false, failed: 0, processed: 0 };
  }

  const client = new FeishuClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: readFeishuApiBaseUrl(),
  });
  const service = createCatalogFieldRefreshService();
  const result = await processCatalogMirrorOutbox({
    apply: ({ actorUserId, sourceSheetId }) =>
      service.apply({
        actorUserId,
        client,
        mode: "MIGRATION_MIRROR",
        reason: "后台执行迁移期飞书货盘全量镜像",
        sourceSheetId,
        sourceWikiToken: config.sourceWikiToken,
      }),
  });
  return { enabled: true, ...result };
}
