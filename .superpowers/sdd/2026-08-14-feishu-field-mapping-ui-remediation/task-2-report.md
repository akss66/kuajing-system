# Task 2 implementation report

Date: 2026-08-14
Task: Reconcile existing SKUs through a read-only, idempotent database backfill

## Outcome

- Confirmation now reconciles product/SKU metadata into PostgreSQL for a non-empty catalog, keyed by `sourceSequence` and `skuCode`.
- Existing SKU balances, reservations, customer prices, orders, and opening movements remain untouched.
- Missing SKUs receive one balance and, when the source total is positive, one opening movement; reconfirming the imported run is a no-op even after the import gate is disabled.
- Product adoption is conservative: a legacy product is reused only when every SKU already attached to it belongs to the current imported source-sequence group. Unrelated sibling SKUs and their product metadata remain untouched.
- Confirmation neither enqueues a cargo target event nor invokes a Feishu writer. Playwright forces `FEISHU_CARGO_WRITES_ENABLED` to `"false"`.
- The panel exposes “只读预检 / 写入本系统数据库” and hides target-write controls while the write gate is false.

## Witnessed RED

1. Existing-catalog acceptance:

   `npm.cmd run test:integration -- tests/integration/feishu/migration-service.test.ts -t 'backfills 74 source sequences across 140 existing SKUs without changing operational state'`

   Exit 1. The old service threw `FeishuCargoMigrationError: Catalog SKUs already exist` (`CATALOG_NOT_EMPTY`) before reconciliation.

2. UI/action/Playwright contract:

   `npm.cmd test -- tests/unit/config/playwright-config-database.test.ts tests/unit/feishu/actions.test.ts tests/unit/feishu/cargo-migration-panel.test.tsx`

   Exit 1: 3 failed / 23 passed. Playwright supplied write gate `"true"`; success copy omitted `74 个来源序号、140 个SKU`; the panel omitted “写入本系统数据库” and retained target-write controls.

3. Imported-run idempotency after closing the import gate:

   The 74/140 test reconfirmed the same run with `cargoImportEnabled: false`.

   Exit 1 with `ROLLOUT_READ_ONLY`, proving the rollout gate ran before the imported-run no-op.

4. Fix Round 1, independent-review finding:

   `npm.cmd run test:integration -- tests/integration/feishu/migration-service.test.ts -t 'does not adopt a legacy product|initializes only the missing SKU once' --reporter=dot --silent=passed-only`

   Exit 1. The unrelated-sibling regression showed `matchedSkuAfter.productId` still equalled the legacy product ID, proving that the old adoption path rewrote a product still used by a manual sibling. The mixed-case test fixture initially used sequence 34's intentional zero inventory; it was corrected to a positive source total (`7`) before using it to verify an opening movement.

## Minimal GREEN implementation

- `queries.ts`: added source-sequence/product and SKU lookup helpers plus a product-sibling SKU query.
- `migration-service.ts`: removed the empty-catalog rejection and target enqueue; reconciles metadata under the existing advisory-lock transaction; preserves operational rows; returns persisted `MigrationSummary`; adds imported-run early no-op; creates inventory only for inserted SKUs; prevents adoption of products with unrelated siblings.
- `actions.ts`, panel, Playwright config, and runbook: aligned the operator language and permanent read-only target gate.
- Tests: cover exact 74 distinct source sequences / 140 SKUs / 140 images, idempotency, preserved balance/reservation/customer price, missing-field and source-failure zero writes, no writer/outbox, mixed existing+missing initialization once, unrelated sibling protection, and `TZX-034-1/2/3` sharing one product.

## GREEN evidence

- `npm.cmd run test:integration -- tests/integration/feishu/migration-service.test.ts -t 'does not adopt a legacy product|initializes only the missing SKU once' --reporter=dot --silent=passed-only`
  - Exit 0; 2 passed / 20 skipped.
- `npm.cmd run test:integration -- tests/integration/feishu/migration-service.test.ts -t 'backfills 74 source sequences across 140 existing SKUs without changing operational state' --reporter=dot --silent=passed-only`
  - Exit 0; 1 passed / 21 skipped; 74/140 acceptance and disabled-gate reconfirmation proven in isolation.
- `npm.cmd run test:integration -- tests/integration/feishu/migration-service.test.ts tests/integration/feishu/source-protection.test.ts --reporter=dot --silent=passed-only`
  - Exit 0; 2 files / 25 tests passed; duration 102.49s.
- `npm.cmd test -- tests/unit/config/playwright-config-database.test.ts tests/unit/feishu/actions.test.ts tests/unit/feishu/cargo-migration-panel.test.tsx`
  - Exit 0; 3 files / 26 tests passed.
- `npm.cmd run test:integration -- tests/integration/feishu/outbox.test.ts tests/integration/inventory/concurrency.test.ts --no-file-parallelism --reporter=dot --silent=passed-only`
  - Exit 0; 2 files / 14 tests passed.
- `npm.cmd run typecheck`
  - Exit 0.
- `git diff --check`
  - Exit 0; only Git's existing LF-to-CRLF working-copy warnings.
- Impeccable detector:
  - `node C:\Users\AKSSINA\.agents\skills\impeccable\scripts\detect.mjs --json src/components/feishu/cargo-migration-panel.tsx`
  - Output `[]`.

## Review and fix loop

- Independent review initially returned Ready: no because legacy product adoption could affect unrelated sibling SKUs and the mixed/grouping coverage was incomplete.
- Fix Round 1 added the conservative sibling check and three regressions: unrelated sibling preservation, mixed existing+missing initialization once, and explicit sequence-34 regrouping.
- Static re-review found no Critical, Important, or Minor findings and returned Ready: yes, subject to clean runtime verification. The clean focused and secondary runs above satisfy that condition.

## Files

- `src/modules/feishu/migration-service.ts`
- `src/modules/feishu/queries.ts`
- `src/modules/feishu/actions.ts`
- `src/components/feishu/cargo-migration-panel.tsx`
- `playwright.config.ts`
- `tests/unit/config/playwright-config-database.test.ts`
- `tests/unit/feishu/actions.test.ts`
- `tests/unit/feishu/cargo-migration-panel.test.tsx`
- `tests/integration/feishu/migration-service.test.ts`
- `tests/integration/feishu/source-protection.test.ts`
- `docs/operations/feishu-cargo-migration.md`

## Self-review and concerns

- Scope contains only the eleven Task 2 owned files plus this required report. It does not touch inventory UI/modules, Jifeng, schema/migrations, or the parent commits `838a286` / `f063a2b`.
- No real Feishu write API was called and nothing was deployed.
- During verification, separate Vitest processes launched by review work shared the same test database and caused transient TRUNCATE/FK interference. After all competing processes stopped, both the exact brief command and an explicit serial control passed. This is test-environment coordination noise, not a product-code failure.
- Residual performance is acceptable for the fixed 140-row one-time operator backfill. The implementation intentionally favors explicit transactional safety over adding broader query/refactor scope.
