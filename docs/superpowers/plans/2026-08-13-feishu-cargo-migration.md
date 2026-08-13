# Feishu Cargo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有飞书业务货盘以只读方式预检并一次性迁入 PostgreSQL，同时迁移 74 张图片，并把数据库货盘安全同步到独立飞书测试表。

**Architecture:** 把飞书集成明确拆为 `source-reader` 与 `target-writer` 两个端口，源知识库 token 永远不能进入写接口。预检把归一化行、源修订号、摘要、错误和临时图片清单持久化；超级管理员确认后在受控事务中创建商品、SKU、库存、资产和审计记录。现有 outbox 只向独立目标 spreadsheet 写入标准化快照与图片，业务数据库始终是唯一数据源。

**Tech Stack:** Next.js 16 Server Components/Server Actions, React 19, TypeScript 6, PostgreSQL 18, Drizzle ORM/Kit, Vitest, Playwright, Docker Compose, Feishu OpenAPI.

## Global Constraints

- 原业务飞书货盘绝不写入、重命名、清空、隐藏、调整格式或新增工作表。
- 极风货盘库存不是可信来源，本计划不读取或导入极风货盘。
- PostgreSQL 是迁移完成后的唯一商品与库存数据源；飞书目标表只是展示镜像。
- 首次导入只允许超级管理员执行，且只在系统 SKU 数为 0、没有成功迁移记录时开放。
- 预检与确认之间源表修订号或内容摘要发生变化时，确认必须失败并要求重新预检。
- 源 wiki token 与目标 spreadsheet token 必须分开配置；相同或解析到同一 spreadsheet 时禁止启动写入任务。
- 所有金额以人民币分保存；库存和重量必须为非负安全整数。
- 图片资产仅接受 JPEG、PNG、WebP，单文件最大 8 MiB、解码像素上限 25,000,000，总迁移容量上限 1 GiB。
- 图片文件保存到 Docker 独立持久卷；数据库和日志不得保存 App Secret、access token 或可复用的飞书素材 token。
- 测试表每个 SKU 一行，不使用合并单元格；写入后冻结表头、设置筛选和合理列宽。
- 所有实现遵循 TDD：先运行有效 RED，再写最小实现，最后运行聚焦与回归验证。
- 不提交真实飞书凭证、生产环境文件、截图或迁移下载的图片。

## File Structure

新增或重点修改的边界如下：

- `src/db/schema/feishu.ts`：迁移运行、图片资产和状态枚举。
- `src/modules/feishu/cargo-types.ts`：迁移 JSON、解析行、问题和临时资产的共享类型。
- `src/integrations/feishu/config.ts`：源/目标分离配置和启动保护。
- `src/integrations/feishu/client.ts`：OpenAPI 传输，包含详细范围读取、素材下载、图片写入和表格样式。
- `src/modules/feishu/source-reader.ts`：只读读取源工作表与图片，不暴露写方法。
- `src/modules/feishu/cargo-parser.ts`：纯函数解析表头、合并单元格、金额、库存、重量、状态、链接与图片关联。
- `src/modules/feishu/asset-storage.ts`：临时/正式图片文件的校验、落盘、恢复和清理。
- `src/modules/feishu/migration-service.ts`：预检、过期校验和首次导入事务。
- `src/modules/feishu/cargo-sync.ts`：只从数据库构建并写入独立测试表。
- `src/modules/feishu/queries.ts`：集成状态和迁移详情读模型。
- `src/modules/feishu/actions.ts`：超级管理员预检/确认和管理员同步操作。
- `src/app/(admin)/admin/system/integrations/page.tsx`：飞书连接、受保护源、预检和目标同步界面。
- `src/app/api/catalog-assets/[assetId]/route.ts`：鉴权后的图片读取。
- `compose.production.yaml` / `Dockerfile`：共享图片持久卷和目录权限。

---

### Task 1: Add Migration and Catalog Asset Schema

**Files:**
- Create: `src/db/schema/feishu.ts`
- Create: `src/modules/feishu/cargo-types.ts`
- Modify: `src/db/schema/index.ts`
- Modify: `src/db/schema/catalog.ts`
- Create: `drizzle/0015_feishu_cargo_migration.sql`
- Create: `drizzle/meta/0014_snapshot.json`
- Create: `drizzle/meta/0015_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Test: `tests/integration/feishu/migration-schema.test.ts`

**Interfaces:**
- Produces: `feishuCargoMigrationRuns`, `catalogAssets`, `feishuCargoMigrationStatus`.
- Produces: `skus.imageAssetId: string | null` while retaining `skus.imageUrl` for backward compatibility during rollout. `catalogAssets` does not point back to SKU; this avoids a circular foreign-key/module dependency and allows identical content-addressed assets to be reused.
- Migration status values: `PREFLIGHT_RUNNING | PREFLIGHT_READY | PREFLIGHT_BLOCKED | IMPORTING | IMPORTED | FAILED | STALE`.

- [ ] **Step 1: Write the failing schema test**

Create a real-PostgreSQL test that inserts one migration run and one catalog asset, verifies one successful imported run at most, and verifies a SKU can reference one asset:

```ts
const [run] = await db.insert(feishuCargoMigrationRuns).values({
  createdByAdminUserId: admin.id,
  normalizedRowsJson: [],
  sourceDigest: "a".repeat(64),
  sourceRevision: 12,
  sourceSheetId: "cargo-sheet",
  sourceSpreadsheetHash: "b".repeat(64),
  status: "PREFLIGHT_READY",
  summaryJson: { imageCount: 74, productCount: 50, skuCount: 74 },
}).returning();

const [asset] = await db.insert(catalogAssets).values({
  byteSize: 1024,
  contentSha256: "c".repeat(64),
  mimeType: "image/png",
  originalFileName: "TZX-001.png",
  storageKey: "sha256/cc/example.png",
}).returning();
```

Also assert DB constraints reject an invalid SHA-256, negative byte size and a second `IMPORTED` migration run. Assert a SKU holds at most one current image reference because `skus.image_asset_id` is a scalar foreign key.

- [ ] **Step 2: Run the schema test and confirm RED**

Run:

```powershell
npm.cmd run test:integration -- tests/integration/feishu/migration-schema.test.ts
```

Expected: FAIL because `@/db/schema` does not export the new tables/columns.

- [ ] **Step 3: Implement the schema**

Define focused tables:

```ts
export const feishuCargoMigrationRuns = pgTable("feishu_cargo_migration_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: feishuCargoMigrationStatus("status").notNull(),
  sourceSpreadsheetHash: varchar("source_spreadsheet_hash", { length: 64 }).notNull(),
  sourceSheetId: varchar("source_sheet_id", { length: 100 }).notNull(),
  sourceRevision: integer("source_revision").notNull(),
  sourceDigest: varchar("source_digest", { length: 64 }).notNull(),
  summaryJson: jsonb("summary_json").$type<MigrationSummary>().notNull(),
  normalizedRowsJson: jsonb("normalized_rows_json").$type<NormalizedCargoRow[]>().notNull(),
  issuesJson: jsonb("issues_json").$type<MigrationIssue[]>().default([]).notNull(),
  temporaryAssetsJson: jsonb("temporary_assets_json").$type<TemporaryAssetManifest[]>().default([]).notNull(),
  createdByAdminUserId: uuid("created_by_admin_user_id").notNull().references(() => adminUsers.id),
  confirmedByAdminUserId: uuid("confirmed_by_admin_user_id").references(() => adminUsers.id),
  importedAt: timestamp("imported_at", { mode: "date", withTimezone: true }),
  failureCode: varchar("failure_code", { length: 80 }),
  failureMessage: text("failure_message"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});
```

`catalogAssets` stores only controlled local metadata; do not store Feishu file tokens. Add unique indexes for `storageKey` and `contentSha256`, plus a partial unique index for `feishu_cargo_migration_runs status='IMPORTED'`.

Define the shared JSON types in `src/modules/feishu/cargo-types.ts` now so the schema uses exact types from the first task:

```ts
export type MigrationIssue = {
  code: string;
  message: string;
  severity: "BLOCKING" | "RETRYABLE" | "WARNING";
  sourceRowNumber?: number;
};

export type MigrationSummary = {
  productCount: number;
  skuCount: number;
  imageCount: number;
  totalQuantity: number;
};

export type TemporaryAssetManifest = {
  byteSize: number;
  contentSha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  originalFileName: string;
  skuCode: string;
  temporaryKey: string;
};

export type NormalizedCargoRow = {
  sourceRowNumber: number;
  productGroupKey: string;
  skuCode: string;
  imageContentSha256: string;
  imageTemporaryKey: string;
  productName: string;
  skuName: string;
  defaultUnitPriceFen: number;
  totalQuantity: number;
  linkText: string;
  productUrl: string;
  specification: string | null;
  color: string | null;
  combination: string | null;
  weightGrams: number | null;
  saleStatus: "SELLABLE" | "NOT_SELLABLE";
  inheritedFrom: Partial<Record<
    "productGroupKey" | "productName" | "image" | "price" |
    "productUrl" | "specification" | "combination" | "weight",
    number
  >>;
};
```

Task 4 consumes and validates this shared row contract rather than redefining it.

- [ ] **Step 4: Repair the missing 0014 Drizzle snapshot before generating 0015**

The repository has `0014_account_governance.sql` and journal entry 14 but no `drizzle/meta/0014_snapshot.json`. Before applying the feature schema changes, generate once against the current pre-feature schema in a temporary clean worktree. The generated SQL must semantically match only the already-committed 0014 account-governance changes. Discard that generated SQL/journal entry, rename its snapshot to `drizzle/meta/0014_snapshot.json`, and verify the snapshot describes the current pre-feature schema. If the generated SQL contains anything outside 0014, stop and reconcile the drift instead of ignoring it.

- [ ] **Step 5: Generate and inspect migration 0015**

Run:

```powershell
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npm.cmd run db:generate
```

After the 0014 snapshot baseline exists, generate from the feature schema. Rename the generated migration to `0015_feishu_cargo_migration.sql` if Drizzle emits a generated adjective name, and update the journal tag consistently. Verify it contains only the Feishu migration tables/indexes and `skus.image_asset_id`; it must contain no account-governance duplicates, table drops or destructive column rewrites.

- [ ] **Step 6: Apply migration to a disposable test database and run GREEN**

Run:

```powershell
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npm.cmd run db:migrate
npm.cmd run test:integration -- tests/integration/feishu/migration-schema.test.ts
npm.cmd run typecheck
```

Expected: migration applies; focused integration and typecheck pass.

- [ ] **Step 7: Commit**

```powershell
git add src/db/schema/feishu.ts src/db/schema/index.ts src/db/schema/catalog.ts src/modules/feishu/cargo-types.ts drizzle/0015_feishu_cargo_migration.sql drizzle/meta tests/integration/feishu/migration-schema.test.ts
git commit -m "feat: add Feishu cargo migration schema"
```

---

### Task 2: Split Feishu Source and Target Configuration with Hard Write Protection

**Files:**
- Modify: `.env.example`
- Modify: `src/integrations/feishu/config.ts`
- Create: `src/integrations/feishu/tokens.ts`
- Modify: `src/jobs/worker.ts`
- Test: `tests/unit/integrations/feishu-config.test.ts`
- Modify: `tests/integration/feishu/outbox.test.ts`

**Interfaces:**
- Produces: `readFeishuConfig(): FeishuIntegrationConfig`.
- Produces: `assertSafeCargoTarget(config, resolvedSourceSpreadsheetToken): void`.
- `FeishuIntegrationConfig` fields:

```ts
type FeishuIntegrationConfig = {
  appId: string;
  appSecret: string;
  sourceWikiToken: string;
  sourceSheetId?: string;
  targetSpreadsheetToken?: string;
  targetSheetId?: string;
  internalChatId?: string;
};
```

- [ ] **Step 1: Write failing configuration tests**

Cover these cases:

```ts
expect(() => readFeishuConfig({
  FEISHU_APP_ID: "app",
  FEISHU_APP_SECRET: "secret",
  FEISHU_CARGO_SOURCE_WIKI_TOKEN: "wiki-source",
  FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN: "same-token",
})).not.toThrow();

expect(() => assertSafeCargoTarget(config, "same-token"))
  .toThrowError("飞书源货盘与目标测试表不能是同一电子表格");
```

Also prove source-only configuration enables preflight but not the worker writer, partial target configuration is rejected, and `FEISHU_INTERNAL_CHAT_ID` is optional until bot notifications are enabled.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
npm.cmd test -- tests/unit/integrations/feishu-config.test.ts
```

Expected: FAIL because the new variables and guard do not exist.

- [ ] **Step 3: Implement source/target config**

Replace legacy `FEISHU_CARGO_WIKI_TOKEN` / `FEISHU_CARGO_SHEET_ID` with:

```dotenv
FEISHU_CARGO_SOURCE_WIKI_TOKEN=
FEISHU_CARGO_SOURCE_SHEET_ID=
FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN=
FEISHU_CARGO_TARGET_SHEET_ID=
FEISHU_INTERNAL_CHAT_ID=
CATALOG_ASSET_DIR=/app/data/catalog-assets
```

Hash tokens with SHA-256 for persistence/log comparison; never expose raw values in errors.

- [ ] **Step 4: Gate worker startup**

Worker behavior:

- App ID + secret + source token: source preflight actions are usable; background target sync stays disabled.
- Target spreadsheet + target sheet must either both exist or both be absent.
- Background sheet sync only starts when app credentials and both target values exist.
- Bot processing only starts when `FEISHU_INTERNAL_CHAT_ID` exists.
- Before each cargo write, resolve the source wiki and call `assertSafeCargoTarget`.
- `FEISHU_API_BASE_URL` may be accepted only when `NODE_ENV !== "production"` for the deterministic fake Feishu server used by integration/E2E tests; production hard-codes `https://open.feishu.cn` and rejects an override.

- [ ] **Step 5: Run focused and regression tests**

```powershell
npm.cmd test -- tests/unit/integrations/feishu-config.test.ts
npm.cmd run test:integration -- tests/integration/feishu/outbox.test.ts
npm.cmd run typecheck
npm.cmd run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add .env.example src/integrations/feishu/config.ts src/integrations/feishu/tokens.ts src/jobs/worker.ts tests/unit/integrations/feishu-config.test.ts tests/integration/feishu/outbox.test.ts
git commit -m "fix: isolate Feishu cargo source and target"
```

---

### Task 3: Extend the Feishu Client for Revisioned Reads and Images

**Files:**
- Modify: `src/integrations/feishu/client.ts`
- Modify: `src/integrations/feishu/index.ts`
- Modify: `tests/unit/integrations/feishu-client.test.ts`

**Interfaces:**
- Produces:

```ts
type FeishuRangeResult = {
  revision: number;
  range: string;
  values: unknown[][];
};

readRangeDetails(input: {
  spreadsheetToken: string;
  range: string;
}): Promise<FeishuRangeResult>;

downloadMedia(fileToken: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  fileName: string | null;
}>;

writeImage(input: {
  spreadsheetToken: string;
  range: string;
  bytes: Uint8Array;
  fileName: string;
}): Promise<unknown>;

setRangeStyle(...): Promise<unknown>;
updateDimension(...): Promise<unknown>;
createFilter(...): Promise<unknown>;
```

- [ ] **Step 1: Expand client contract tests**

Mock official API responses and assert:

- detailed range reads retain `revision` and raw rich cell values;
- media download returns binary bytes without JSON parsing;
- `values_image` sends `{ range, image: number[], name }`;
- HTTP 403 media errors are permanent and sanitized;
- response size is bounded before buffering.

Representative assertion:

```ts
expect(await client.readRangeDetails({
  range: "sheet-1!A1:Z500",
  spreadsheetToken: "source-token",
})).toMatchObject({ revision: 112, range: "sheet-1!A1:Z500" });
```

- [ ] **Step 2: Run and confirm RED**

```powershell
npm.cmd test -- tests/unit/integrations/feishu-client.test.ts
```

Expected: FAIL on missing methods.

- [ ] **Step 3: Implement transport methods**

Keep tenant token caching centralized. Add a binary fetch path that shares timeout and authorization but never calls `.json()`. Enforce:

```ts
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
```

Reject declared or streamed content exceeding the bound. Parse `content-disposition` defensively and never use it as a filesystem path.

- [ ] **Step 4: Verify GREEN**

```powershell
npm.cmd test -- tests/unit/integrations/feishu-client.test.ts
npm.cmd run typecheck
npm.cmd run lint
```

- [ ] **Step 5: Commit**

```powershell
git add src/integrations/feishu/client.ts src/integrations/feishu/index.ts tests/unit/integrations/feishu-client.test.ts
git commit -m "feat: read Feishu cargo revisions and images"
```

---

### Task 4: Parse and Validate the Legacy Cargo Sheet

**Files:**
- Modify: `src/modules/feishu/cargo-types.ts`
- Create: `src/modules/feishu/cargo-parser.ts`
- Create: `tests/fixtures/feishu/cargo-source-values.json`
- Create: `tests/unit/feishu/cargo-parser.test.ts`

**Interfaces:**
- Consumes: raw `unknown[][]` from `readRangeDetails` and issue/summary types from Task 1.
- Produces an ephemeral parsed row containing the Feishu material token. This type must never be persisted or logged:

```ts
type ParsedCargoRow = Omit<
  NormalizedCargoRow,
  "imageContentSha256" | "imageTemporaryKey"
> & { imageFileToken: string };

type CargoParseResult = {
  headerRowNumber: number;
  rows: ParsedCargoRow[];
  issues: MigrationIssue[];
  summary: MigrationSummary;
};
```

- [ ] **Step 1: Build a sanitized fixture from the observed layout**

The fixture must include:

- one product represented by three SKU rows;
- blank cells caused by merged product-level cells;
- one zero-stock/not-sellable SKU;
- rich hyperlink segments with display text and URL;
- image cells shaped like Feishu `{ fileToken, link, text }` values;
- Chinese and ASCII weight forms such as `218g`, `0.218kg`, `218 克`.

Do not copy real private links or file tokens into git; use synthetic tokens and `https://example.test/...`.

- [ ] **Step 2: Write parser RED tests**

Cover exact behavior:

```ts
expect(result.rows).toHaveLength(4);
expect(result.rows.slice(0, 3).map((row) => row.productGroupKey))
  .toEqual(["1", "1", "1"]);
expect(result.rows[1].inheritedFrom.productName).toBe(2);
expect(result.rows[1].skuCode).toBe("TZX-001-2");
expect(result.rows[3].saleStatus).toBe("NOT_SELLABLE");
```

Add blocking tests for duplicate/missing SKU, negative/fractional inventory, invalid price, missing true URL, unrecognized status, unsafe weight, and image ambiguity. Assert SKU, color, inventory and explicit state are never inherited.

- [ ] **Step 3: Run and confirm RED**

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts
```

- [ ] **Step 4: Implement pure parser**

Detect the header row by required normalized labels (`SKU`, `名称`, `采购价`, `总库存`, `状态`) within the first 20 rows. Use alias sets only for known variants such as `总库存(份)`; unknown headers are not silently mapped.

Parse monetary values with a decimal-string function, not binary floating arithmetic:

```ts
parseYuanToFen("2.93") === 293;
```

Classify issues as `BLOCKING`, `RETRYABLE`, or `WARNING`, with stable codes and source row numbers.

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts
npm.cmd run typecheck
npm.cmd run lint
```

- [ ] **Step 6: Commit**

```powershell
git add src/modules/feishu/cargo-types.ts src/modules/feishu/cargo-parser.ts tests/fixtures/feishu/cargo-source-values.json tests/unit/feishu/cargo-parser.test.ts
git commit -m "feat: parse legacy Feishu cargo sheets"
```

---

### Task 5: Add Safe Image Storage and Authenticated Asset Delivery

**Files:**
- Create: `src/modules/feishu/asset-storage.ts`
- Create: `src/app/api/catalog-assets/[assetId]/route.ts`
- Modify: `Dockerfile`
- Modify: `compose.production.yaml`
- Modify: `.env.example`
- Create: `tests/unit/feishu/asset-storage.test.ts`
- Create: `tests/integration/catalog/assets-route.test.ts`

**Interfaces:**
- Produces:

```ts
stageCatalogAsset(input: {
  runId: string;
  skuCode: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<TemporaryAssetManifest>;

commitCatalogAsset(manifest: TemporaryAssetManifest): Promise<string>;
discardStagedAssets(runId: string): Promise<void>;
openCatalogAsset(storageKey: string): Promise<{ bytes: Uint8Array; contentType: string }>;
```

- [ ] **Step 1: Write RED security tests**

Test valid PNG/JPEG/WebP magic bytes, mismatched MIME, SVG rejection, oversized files, decompression-bomb dimensions, traversal-like SKU codes, content-addressed deduplication, temporary cleanup and final path containment.

Route tests must assert unauthenticated requests return 401, authenticated admin/customer requests return the asset with `X-Content-Type-Options: nosniff`, and unknown IDs return 404 without leaking paths.

- [ ] **Step 2: Run and confirm RED**

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
```

- [ ] **Step 3: Implement storage**

Use a content-addressed key:

```ts
const storageKey = `sha256/${digest.slice(0, 2)}/${digest}.${extension}`;
```

Both temporary and final paths must be resolved and checked to remain under `CATALOG_ASSET_DIR`. Use `fs.open(..., "wx")` or atomic rename to avoid overwrite races. Never serve source filenames directly.

- [ ] **Step 4: Add the production volume**

In `Dockerfile`, create `/app/data/catalog-assets` owned by `nextjs:nodejs`. In `compose.production.yaml`, mount one named volume into both `web` and `worker`:

```yaml
volumes:
  - catalog_assets:/app/data/catalog-assets
```

Declare:

```yaml
volumes:
  catalog_assets:
    name: tongzhouxing_shop_catalog_assets
```

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
npm.cmd run typecheck
npm.cmd run lint
docker compose -f compose.production.yaml config --quiet
```

- [ ] **Step 6: Commit**

```powershell
git add src/modules/feishu/asset-storage.ts src/app/api/catalog-assets Dockerfile compose.production.yaml .env.example tests/unit/feishu/asset-storage.test.ts tests/integration/catalog/assets-route.test.ts
git commit -m "feat: store catalog images in a protected volume"
```

---

### Task 6: Build Read-Only Preflight and First Import Services

**Files:**
- Create: `src/modules/feishu/source-reader.ts`
- Create: `src/modules/feishu/migration-service.ts`
- Create: `src/modules/feishu/queries.ts`
- Create: `tests/integration/feishu/migration-service.test.ts`
- Create: `tests/integration/feishu/source-protection.test.ts`

**Interfaces:**
- Consumes: `FeishuClient.readRangeDetails`, `downloadMedia`, `parseCargoSheet`, asset storage and Task 1 tables.
- Produces:

```ts
createCargoPreflight(input: {
  actor: SuperAdminPrincipal;
  sourceSheetId?: string;
  client: FeishuSourcePort;
  config: FeishuIntegrationConfig;
}): Promise<{ runId: string; status: "PREFLIGHT_READY" | "PREFLIGHT_BLOCKED" }>;

confirmCargoMigration(input: {
  actor: SuperAdminPrincipal;
  runId: string;
  client: FeishuSourcePort;
  config: FeishuIntegrationConfig;
}): Promise<{ productCount: number; skuCount: number; imageCount: number }>;
```

- [ ] **Step 1: Write source-protection RED tests**

Define `FeishuSourcePort` with only:

```ts
resolveWikiSpreadsheet;
listSheets;
readRangeDetails;
downloadMedia;
```

The type and runtime tests must prove the source reader has no write method, reads only the configured source sheet/range, and hashes source tokens before persistence. Use a fake client whose write methods throw if called; assert zero write calls through the full preflight.

- [ ] **Step 2: Write migration-service RED tests**

Cover:

- source with 74 valid rows produces `PREFLIGHT_READY`, 74 staged assets and no products/SKUs;
- blocking parser issue produces `PREFLIGHT_BLOCKED`;
- image 403 produces blocking failure with sanitized error;
- transient image error is marked retryable;
- ordinary admin cannot create/confirm migration;
- changed revision or digest marks run `STALE`;
- non-empty SKU table blocks confirmation;
- existing imported run blocks confirmation;
- transaction failure leaves zero products/SKUs/balances/movements and cleans committed files;
- successful confirmation groups products, creates 74 SKUs/assets/balances, creates movements only for positive initial quantities, adds audit logs and enqueues one target sync;
- calling confirm twice does not duplicate data.

- [ ] **Step 3: Run and confirm RED**

```powershell
npm.cmd run test:integration -- tests/integration/feishu/source-protection.test.ts tests/integration/feishu/migration-service.test.ts
```

- [ ] **Step 4: Implement preflight**

Read `A1:Z500` from the explicitly selected sheet. `ParsedCargoRow.imageFileToken` exists only in memory while downloading the asset. Replace it with `imageContentSha256` and `imageTemporaryKey` before persisting `normalizedRowsJson`; assert serialized preflight JSON contains no `fileToken`, source download URL or raw spreadsheet token. Persist the exact revision, digest of normalized canonical JSON, summary, issues and temporary asset manifests. Store `sourceSpreadsheetHash = sha256(resolvedSpreadsheetToken)` only.

When no source sheet ID is configured and multiple sheets exist, return a typed `SOURCE_SHEET_SELECTION_REQUIRED` result containing sheet IDs/titles rather than selecting the first sheet silently.

- [ ] **Step 5: Implement confirmation transaction**

Acquire a PostgreSQL advisory transaction lock for the singleton migration, then lock/check the SKU table and successful-run uniqueness. Re-read and reparse the source before writing. Insert one `products` row per `productGroupKey`, all `skus`, `catalogAssets`, `inventoryBalances`, initial `inventoryMovements` for quantities greater than zero, and audit logs.

Set each SKU image URL to the controlled route:

```ts
imageUrl: `/api/catalog-assets/${asset.id}`
```

Move staged files before the transaction callback returns; on any SQL/commit failure remove only files newly created by this run and not referenced by another asset row.

- [ ] **Step 6: Verify GREEN and concurrency**

```powershell
npm.cmd run test:integration -- tests/integration/feishu/source-protection.test.ts tests/integration/feishu/migration-service.test.ts
npm.cmd run test:integration -- tests/integration/inventory/concurrency.test.ts
npm.cmd run typecheck
npm.cmd run lint
```

Expected: all pass; two concurrent confirm calls produce exactly one import and one deterministic conflict result, never partial data.

- [ ] **Step 7: Commit**

```powershell
git add src/modules/feishu/source-reader.ts src/modules/feishu/migration-service.ts src/modules/feishu/queries.ts tests/integration/feishu/migration-service.test.ts tests/integration/feishu/source-protection.test.ts
git commit -m "feat: preflight and import Feishu cargo safely"
```

---

### Task 7: Rebuild Outbound Sync for the Independent Test Spreadsheet

**Files:**
- Modify: `src/modules/feishu/cargo-sync.ts`
- Modify: `src/modules/feishu/outbox.ts`
- Modify: `src/integrations/feishu/client.ts`
- Modify: `tests/integration/feishu/cargo-sync.test.ts`
- Modify: `tests/integration/feishu/outbox.test.ts`

**Interfaces:**
- Consumes: target spreadsheet token/sheet ID, database snapshot, catalog asset storage.
- Produces:

```ts
type FeishuCargoTargetPort = {
  readRange(input: { spreadsheetToken: string; range: string }): Promise<unknown[][]>;
  writeRange(input: { spreadsheetToken: string; range: string; values: CargoCell[][] }): Promise<unknown>;
  writeImage(input: { spreadsheetToken: string; range: string; bytes: Uint8Array; fileName: string }): Promise<unknown>;
  setRangeStyle(...): Promise<unknown>;
  updateDimension(...): Promise<unknown>;
  createFilter(...): Promise<unknown>;
};
```

- [ ] **Step 1: Replace old sync tests with target-only RED tests**

Assert the sync call receives a direct target spreadsheet token and never calls `resolveWikiSpreadsheet`. Assert the exact columns:

```ts
[
  "序号", "SKU", "图片", "名称", "采购价", "总库存",
  "可售库存", "商品链接", "规格", "颜色", "组合销售", "重量", "状态",
]
```

Also assert every SKU is one row, same-product rows are adjacent, stale trailing rows are cleared, images are written only to the target `C` cell, filter/header/column sizing calls are target-only, and source/target equality aborts before the first write.

- [ ] **Step 2: Run and confirm RED**

```powershell
npm.cmd run test:integration -- tests/integration/feishu/cargo-sync.test.ts tests/integration/feishu/outbox.test.ts
```

- [ ] **Step 3: Implement target-only writer**

`syncCargoSnapshot` must accept:

```ts
config: {
  sourceSpreadsheetToken: string;
  targetSpreadsheetToken: string;
  targetSheetId: string;
}
```

Call `assertSafeCargoTarget` before reading/clearing the target. Write text values first, then use `/values_image` serially for the 74 image cells, respecting Feishu's per-document serial write restriction. Freeze row 1, create/update a filter across `A1:M{rowCount}`, and set a practical image row height and column widths. Do not merge cells.

- [ ] **Step 4: Make worker failures monotonic and retryable**

Keep database mutations unaffected by Feishu failure. Coalesce cargo sync events as today, but retain `PERMANENT_FAILURE` for permission/config errors and exponential backoff for 429/5xx/timeouts. Response metadata stores only row/image counts and target sheet ID.

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd run test:integration -- tests/integration/feishu/cargo-sync.test.ts tests/integration/feishu/outbox.test.ts
npm.cmd test -- tests/unit/integrations/feishu-client.test.ts
npm.cmd run typecheck
npm.cmd run lint
```

- [ ] **Step 6: Commit**

```powershell
git add src/modules/feishu/cargo-sync.ts src/modules/feishu/outbox.ts src/integrations/feishu/client.ts tests/integration/feishu/cargo-sync.test.ts tests/integration/feishu/outbox.test.ts
git commit -m "feat: sync cargo to an isolated Feishu test sheet"
```

---

### Task 8: Add Super-Admin Migration Controls and Integration Status

**Files:**
- Modify: `src/modules/feishu/actions.ts`
- Modify: `src/modules/feishu/queries.ts`
- Modify: `src/app/(admin)/admin/system/integrations/page.tsx`
- Create: `src/components/feishu/cargo-migration-panel.tsx`
- Create: `src/components/feishu/cargo-preflight-table.tsx`
- Create: `tests/unit/feishu/cargo-migration-panel.test.tsx`
- Create: `tests/unit/feishu/actions.test.ts`
- Create: `tests/e2e/feishu-cargo-migration.spec.ts`

**Interfaces:**
- Consumes: Task 6 service and queries.
- Produces actions:

```ts
createCargoPreflightAction(previous: ActionState, formData: FormData): Promise<ActionState>;
confirmCargoMigrationAction(previous: ActionState, formData: FormData): Promise<ActionState>;
retryFeishuCargoSyncAction(previous: ActionState, formData: FormData): Promise<ActionState>;
```

- [ ] **Step 1: Write UI/action RED tests**

Unit tests must assert:

- ordinary admin sees connection/sync status but not first-import controls;
- super admin can choose a source sheet, start preflight and inspect all final field values;
- blocking issues disable confirmation;
- `PREFLIGHT_READY` displays product/SKU/image/stock totals and an explicit “原业务货盘受保护，系统不会写入” notice;
- confirm uses `ConfirmedActionForm` and requires entering the exact confirmation phrase `确认迁移74个SKU`;
- imported state permanently removes the first-import action;
- raw tokens, file tokens and secrets never render.

- [ ] **Step 2: Run and confirm RED**

```powershell
npm.cmd test -- tests/unit/feishu/cargo-migration-panel.test.tsx tests/unit/feishu/actions.test.ts
```

- [ ] **Step 3: Implement actions and read models**

Use `requireSuperAdmin()` for preflight and confirmation. `testFeishuConnectionAction` is read-only: resolve source, list sheets, fetch target metadata, but never write a probe cell. Manual sync requires target configuration and only enqueues a target event.

Return stable Chinese messages for:

- source permission missing;
- sheet selection required;
- preflight blocked;
- source changed/stale;
- system already has SKU;
- migration already imported;
- target not configured;
- sync queued.

- [ ] **Step 4: Implement the admin panel**

Keep it inside the existing integrations information architecture. The preflight table must show source row, product group, SKU, image state, name, price, inventory, URL, specifications, weight, status, inherited fields and issues. Large tables use the existing responsive workspace/table components; on mobile, use summary cards rather than horizontal page overflow.

- [ ] **Step 5: Add E2E with a fake Feishu server**

Do not call real Feishu in CI. Start a deterministic local fake server from the Playwright test or test support module and use the non-production-only `FEISHU_API_BASE_URL` override defined in Task 2, then prove:

- super admin preflights a 74-SKU fixture without any write request to the source token;
- confirmation creates 74 SKU records and image route responses;
- target sync writes only to the configured target token;
- customer catalog shows an imported image and correct sellability;
- ordinary admin cannot invoke confirmation.

- [ ] **Step 6: Run focused gates**

```powershell
npm.cmd test -- tests/unit/feishu/cargo-migration-panel.test.tsx tests/unit/feishu/actions.test.ts
npm.cmd run test:e2e -- tests/e2e/feishu-cargo-migration.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

- [ ] **Step 7: Commit**

```powershell
git add src/modules/feishu/actions.ts src/modules/feishu/queries.ts src/app/'(admin)'/admin/system/integrations/page.tsx src/components/feishu tests/unit/feishu tests/e2e/feishu-cargo-migration.spec.ts
git commit -m "feat: govern Feishu cargo migration in admin"
```

---

### Task 9: Release Verification, Deployment Runbook, and Read-Only Live Preflight

**Files:**
- Modify: `README.md`
- Create: `docs/operations/feishu-cargo-migration.md`
- Modify: `tests/e2e/customer-catalog.spec.ts`
- Modify: `tests/e2e/merchant-center-visual.spec.ts` only if the integration panel gains approved visual coverage

**Interfaces:**
- Consumes all prior tasks.
- Produces a release checklist and exact production procedure; it does not store credentials.

- [ ] **Step 1: Write the operations runbook**

Document exact human steps:

1. Create an independent blank Feishu spreadsheet named `同舟行系统货盘测试`.
2. Add `同舟行跨境货盘同步` as an editable collaborator on the test spreadsheet.
3. Copy its spreadsheet token and first sheet ID from the URL/API sheet list.
4. Put App ID/secret/source wiki token/source sheet ID/target spreadsheet token/target sheet ID into `/home/admin/tongzhouxing-shop/.env.production` using an interactive editor; never print them in shell history.
5. Set `CATALOG_ASSET_DIR=/app/data/catalog-assets`.
6. Back up PostgreSQL and the new catalog asset volume before confirmation.
7. Deploy, migrate schema, start web/worker, and verify health.
8. Run connection test and preflight only; verify the original source has no revision/content change caused by the application.
9. Schedule the 10–20 minute freeze, rerun preflight, review 74 SKU/74 images, then confirm.
10. Verify the isolated test spreadsheet and system catalog; do not switch the customer link without a separate approval.

- [ ] **Step 2: Run complete automated gates**

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run test:e2e -- --workers 1
npm.cmd run typecheck
npm.cmd run lint
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npm.cmd run db:migrate
npm.cmd run build
git diff --check
```

Expected: all tests pass; no runtime skips introduced by this feature; build succeeds with explicit non-production test environment values.

- [ ] **Step 3: Perform source-write static audit**

Run:

```powershell
rg -n "writeRange|writeImage|values_image|styles_batch_update|createFilter" src/modules/feishu src/integrations/feishu
rg -n "FEISHU_CARGO_SOURCE|sourceWikiToken|sourceSpreadsheet" src/modules/feishu src/integrations/feishu src/jobs
```

Review every write call and prove its spreadsheet token comes from `targetSpreadsheetToken`, never from `sourceWikiToken` or resolved source spreadsheet token. Record this evidence in the task report/commit message notes.

- [ ] **Step 4: Verify production compose without deploying secrets**

```powershell
docker compose -f compose.production.yaml config --quiet
docker build -t tongzhouxing-shop:feishu-cargo-candidate .
```

Run the candidate with a disposable database and asset volume; verify the unprivileged `nextjs` user can create/read/delete a staged asset.

- [ ] **Step 5: Update customer catalog regression**

Add an assertion that an authenticated customer can load the imported protected image URL and that a `NOT_SELLABLE` or zero-stock SKU cannot be ordered. Run desktop and 390-pixel mobile projects.

- [ ] **Step 6: Commit release documentation and final regression**

```powershell
git add README.md docs/operations/feishu-cargo-migration.md tests/e2e/customer-catalog.spec.ts tests/e2e/merchant-center-visual.spec.ts
git commit -m "docs: prepare Feishu cargo migration rollout"
```

- [ ] **Step 7: Stop before live confirmation**

After deployment, execute only connection testing and read-only preflight. Present the preflight counts/issues and source revision evidence to the user. Do not invoke `confirmCargoMigrationAction`, do not write the test spreadsheet, and do not change the original business spreadsheet until the user explicitly approves the live migration result in a later message.

---

## Plan Self-Review

- Spec coverage: source protection, 74 SKU/image preflight, grouped products, field validation, transactional import, assets, audit, target-only mirror, worker retry, admin controls, Docker volume, live freeze and separate cutover approval are each assigned to a task.
- Completeness scan: every code step names its concrete behavior, test command and success condition; unknown credentials are handled through an interactive production procedure rather than embedded values.
- Type consistency: `MigrationIssue`, `MigrationSummary` and `TemporaryAssetManifest` are created in Task 1; `FeishuIntegrationConfig` in Task 2; `NormalizedCargoRow` in Task 4; `FeishuSourcePort` in Task 6; and `FeishuCargoTargetPort` in Task 7, before each downstream use.
- Safety consistency: no task authorizes a write to the source business spreadsheet; Task 9 explicitly stops before live confirmation and target sync.
