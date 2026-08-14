import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { adminUsers, authUsers, feishuCargoMigrationRuns } from "@/db/schema";
import { FeishuClient } from "@/integrations/feishu/client";
import { readFeishuApiBaseUrl, readFeishuConfig } from "@/integrations/feishu/config";
import {
  createCatalogFieldRefreshService,
  type CatalogFieldRefreshReadPort,
} from "@/modules/feishu/catalog-field-refresh";
import { parseCatalogFieldRefreshCliArguments } from "@/modules/feishu/catalog-field-refresh-cli";

const BOOTSTRAP_SUPER_ADMIN_ID = "00000000-0000-4000-8000-00000000a001";

async function resolveSourceSheetId(configuredSourceSheetId: string | undefined) {
  if (configuredSourceSheetId?.trim()) return configuredSourceSheetId.trim();
  const [latestRun] = await db
    .select({ sourceSheetId: feishuCargoMigrationRuns.sourceSheetId })
    .from(feishuCargoMigrationRuns)
    .where(eq(feishuCargoMigrationRuns.status, "IMPORTED"))
    .orderBy(desc(feishuCargoMigrationRuns.importedAt), desc(feishuCargoMigrationRuns.createdAt))
    .limit(1);
  if (!latestRun) throw new Error("No imported Feishu source sheet is available");
  return latestRun.sourceSheetId;
}

async function resolveBootstrapActorId() {
  const actors = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .innerJoin(adminUsers, eq(adminUsers.loginIdentifier, authUsers.email))
    .where(
      and(
        eq(authUsers.id, BOOTSTRAP_SUPER_ADMIN_ID),
        eq(authUsers.role, "super_admin"),
        eq(adminUsers.status, "ACTIVE"),
      ),
    );
  if (actors.length !== 1) throw new Error("Expected one active bootstrap super-admin");
  return actors[0]!.id;
}

async function main() {
  const options = parseCatalogFieldRefreshCliArguments(process.argv.slice(2));

  const config = readFeishuConfig();
  const sourceSheetId = await resolveSourceSheetId(config.sourceSheetId);
  const feishuClient = new FeishuClient({
    appId: config.appId,
    appSecret: config.appSecret,
    baseUrl: readFeishuApiBaseUrl(),
  });
  const client: CatalogFieldRefreshReadPort = {
    listSheets: feishuClient.listSheets.bind(feishuClient),
    readRangeDetails: feishuClient.readRangeDetails.bind(feishuClient),
    resolveWikiSpreadsheet: feishuClient.resolveWikiSpreadsheet.bind(feishuClient),
  };
  const service = createCatalogFieldRefreshService();
  const baseInput = {
    client,
    expectedSkuCount: options.expectedSkuCount,
    expectedSourceSequenceCount: options.expectedSourceSequenceCount,
    sourceSheetId,
    sourceWikiToken: config.sourceWikiToken,
  };
  const result = options.apply
    ? await service.apply({
        ...baseInput,
        actorUserId: await resolveBootstrapActorId(),
        reason: options.reason,
      })
    : await service.preview(baseInput);

  console.info(JSON.stringify({
    matchedSkuCount: result.matchedSkuCount,
    mode: options.apply ? "apply" : "preview",
    productsToMerge: result.productsToMerge,
    skuCount: result.skuCount,
    sourceSequenceCount: result.sourceSequenceCount,
  }));
}

await main();
