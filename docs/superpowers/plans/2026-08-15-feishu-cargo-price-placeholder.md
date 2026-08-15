# Feishu Cargo Price Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the read-only Feishu cargo source into the system with an explicit, audited `¥99.00` database-only placeholder for `TZX-076`, then deploy the verified grouped catalog release.

**Architecture:** Extend the cargo parser with an optional SKU-scoped placeholder map while preserving strict default behavior. Thread applied placeholder metadata through preview/apply, CLI output, and the existing catalog refresh audit transaction. Production remains Feishu-read-only; deployment occurs only after a 76-product/140-SKU preview and a fresh database backup.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/Drizzle ORM, Next.js 16, Docker Compose, Feishu read APIs.

## Global Constraints

- Never call a Feishu write API; `FEISHU_CARGO_WRITES_ENABLED=false` and `FEISHU_CARGO_IMPORT_ENABLED=false` remain enforced.
- The only approved placeholder is `TZX-076:99.00`, represented internally as `99000` milli-yuan.
- A placeholder applies only when that SKU's Feishu cargo-price cell is blank.
- All other missing or invalid cargo prices remain blocking.
- Production apply requires exact counts: 76 source sequences and 140 SKUs.
- Preserve the existing production database, catalog asset volume, dyflow services, and rollback release `70318a2`.

---

### Task 1: Parser placeholder contract

**Files:**
- Modify: `src/modules/feishu/cargo-types.ts`
- Modify: `src/modules/feishu/cargo-parser.ts`
- Test: `tests/unit/feishu/cargo-parser.test.ts`

**Interfaces:**
- Produces `CargoPricePlaceholder = { skuCode: string; unitPriceMilliYuan: number }`.
- Produces `AppliedCargoPricePlaceholder = CargoPricePlaceholder & { sourceRowNumber: number }`.
- Extends `parseLegacyCargoSheet(values, options?)` with `cargoPricePlaceholders?: readonly CargoPricePlaceholder[]`.
- Extends `CargoParseResult` with `appliedCargoPricePlaceholders`.

- [ ] **Step 1: Write failing parser tests**

Add tests proving:

```ts
expect(parseLegacyCargoSheet(values).issues).toContainEqual(
  expect.objectContaining({ code: "CARGO_INVALID_CARGO_PRICE" }),
);

const parsed = parseLegacyCargoSheet(values, {
  cargoPricePlaceholders: [
    { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
  ],
});
expect(parsed.appliedCargoPricePlaceholders).toEqual([
  { skuCode: "TZX-076", sourceRowNumber: 141, unitPriceMilliYuan: 99_000 },
]);
expect(parsed.issues).toContainEqual(expect.objectContaining({
  code: "CARGO_PRICE_PLACEHOLDER_APPLIED",
  severity: "WARNING",
}));
```

Also prove a placeholder on a nonblank source price blocks with `CARGO_PRICE_PLACEHOLDER_NOT_NEEDED`, and a placeholder for a missing SKU blocks with `CARGO_PRICE_PLACEHOLDER_UNUSED`.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts
```

Expected: FAIL because the parser does not accept placeholder options or return applied metadata.

- [ ] **Step 3: Implement the minimal parser behavior**

Validate placeholder declarations before parsing rows:

```ts
export type CargoPricePlaceholder = {
  skuCode: string;
  unitPriceMilliYuan: number;
};

export function parseLegacyCargoSheet(
  values: unknown[][],
  options: { cargoPricePlaceholders?: readonly CargoPricePlaceholder[] } = {},
): CargoParseResult
```

For the matching blank cargo-price cell, use `unitPriceMilliYuan`, record an applied item, and emit a warning. Perform all rejection checks before mutating inherited cargo-price context. After parsing, emit a blocking unused-placeholder issue for any declaration not applied exactly once.

- [ ] **Step 4: Verify GREEN**

Run the parser unit file and expect all tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/feishu/cargo-types.ts src/modules/feishu/cargo-parser.ts tests/unit/feishu/cargo-parser.test.ts
git commit -m "feat: support audited cargo price placeholders"
```

---

### Task 2: Refresh service, CLI, and audit propagation

**Files:**
- Modify: `src/modules/feishu/catalog-field-refresh.ts`
- Modify: `src/modules/feishu/catalog-field-refresh-cli.ts`
- Modify: `scripts/refresh-feishu-catalog-fields.ts`
- Test: `tests/unit/feishu/catalog-field-refresh-cli.test.ts`
- Test: `tests/integration/feishu/catalog-field-refresh.test.ts`

**Interfaces:**
- Consumes `CargoPricePlaceholder` and `AppliedCargoPricePlaceholder` from Task 1.
- Extends preview/apply inputs with `cargoPricePlaceholders`.
- Extends `CatalogFieldRefreshPreview` with `cargoPricePlaceholders`.
- CLI consumes `--cargo-price-placeholder=TZX-076:99.00`.

- [ ] **Step 1: Write failing CLI and integration tests**

CLI assertions:

```ts
expect(parseCatalogFieldRefreshCliArguments([
  "--cargo-price-placeholder=TZX-076:99.00",
])).toMatchObject({
  cargoPricePlaceholders: [
    { skuCode: "TZX-076", unitPriceMilliYuan: 99_000 },
  ],
});
```

Reject malformed, duplicate, zero/negative, or non-two-decimal values with `INVALID_CARGO_PRICE_PLACEHOLDER`.

Integration assertions must prove preview returns the applied item, apply stores `products.cargoUnitPriceMilliYuan = 99_000` for the `TZX-076` parent, and `audit_logs.after_json` contains the same placeholder metadata.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm.cmd test -- tests/unit/feishu/catalog-field-refresh-cli.test.ts
npm.cmd run test:integration -- tests/integration/feishu/catalog-field-refresh.test.ts --maxWorkers 1
```

Expected: FAIL because CLI/service/audit do not carry placeholder metadata.

- [ ] **Step 3: Implement service and CLI propagation**

Pass the declared placeholders into `prepareSource()`, return only parser-confirmed applied placeholders, include them in preview/apply results, and insert them into the existing `CATALOG_FIELDS_REFRESHED_FROM_FEISHU` audit `afterJson`.

Parse the CLI value with a strict expression equivalent to:

```ts
/^(TZX-\d+(?:-\d+)?):(\d+\.\d{2})$/
```

Convert `99.00` to `99_000` milli-yuan without floating-point rounding.

- [ ] **Step 4: Verify GREEN and full local gates**

Run:

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:e2e -- tests/e2e/feishu-cargo-migration.spec.ts --workers 1
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Independent review and commit**

Review for placeholder leakage, inherited-context mutation, audit completeness, and Feishu zero-write behavior. Then commit:

```powershell
git add src/modules/feishu/catalog-field-refresh.ts src/modules/feishu/catalog-field-refresh-cli.ts scripts/refresh-feishu-catalog-fields.ts tests/unit/feishu/catalog-field-refresh-cli.test.ts tests/integration/feishu/catalog-field-refresh.test.ts
git commit -m "feat: audit Feishu cargo price placeholder"
```

---

### Task 3: Production preview, transactional refresh, and cutover

**Files:**
- No tracked source files.
- Append ignored evidence: `.superpowers/sdd/2026-08-15-grouped-catalog-products/task-5-report.md`

**Interfaces:**
- Consumes the operational CLI from Task 2.
- Produces an immutable Docker image tagged from `git rev-parse --short HEAD` and verified production state.

- [ ] **Step 1: Build and upload the immutable release**

Set `RELEASE_SHA="$(git rev-parse --short HEAD)"`, create `git archive` from that commit, verify SHA-256 after upload, extract into `/home/admin/tongzhouxing-shop/releases/$RELEASE_SHA`, and build `tongzhouxing-shop:$RELEASE_SHA`. Do not restart services.

- [ ] **Step 2: Run read-only production preview**

Run the one-off web container with both Feishu write/import flags false:

```sh
npm run ops:refresh-feishu-catalog-fields -- \
  --expected-source-sequences=76 \
  --expected-skus=140 \
  --cargo-price-placeholder=TZX-076:99.00
```

Require output:

```json
{
  "sourceSequenceCount": 76,
  "skuCount": 140,
  "matchedSkuCount": 140,
  "cargoPricePlaceholders": [
    { "skuCode": "TZX-076", "unitPriceMilliYuan": 99000 }
  ]
}
```

- [ ] **Step 3: Create a fresh production database backup**

Write a timestamped PostgreSQL custom-format dump under `/home/admin/tongzhouxing-shop/backups/task5-grouped-catalog/`, verify it with `pg_restore --list`, and record SHA-256 before apply.

- [ ] **Step 4: Apply the refresh transaction**

Run:

```sh
npm run ops:refresh-feishu-catalog-fields -- \
  --apply \
  --expected-source-sequences=76 \
  --expected-skus=140 \
  --cargo-price-placeholder=TZX-076:99.00 \
  --reason="按确认规则重组76个货盘产品；TZX-076系统临时货品价格占位99元"
```

Require the same counts as preview. Verify SQL facts: 76 non-null source sequences, 140 SKUs, `TZX-076` parent cargo price `99000`, and the latest audit row contains the placeholder metadata.

- [ ] **Step 5: Cut over web and worker**

Run Compose from `/home/admin/tongzhouxing-shop/releases/$RELEASE_SHA` with `APP_VERSION=$RELEASE_SHA`, `APP_ENV_FILE=/home/admin/tongzhouxing-shop/secrets/.env.production`, and `FEISHU_CARGO_IMPORT_ENABLED=false`. Recreate only `web` and `worker`; leave postgres and dyflow untouched.

- [ ] **Step 6: Verify and retain rollback**

Require container health, `https://shop.tzxai.top/api/health` success, admin/customer catalog smoke checks, 76 grouped products/140 SKUs, and `TZX-076` price visibility. If any check fails, restore web/worker to release `70318a2`; restore the new backup only if the database verification itself failed.
