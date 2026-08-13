# Task 9 Phase A Report

Date: 2026-08-13
Worktree: `C:\Users\AKSSINA\Desktop\kuajinng\.worktrees\feishu-cargo-migration`
Start HEAD: `d0797e3`
Phase boundary: release preparation and verification only. No SSH, no live deploy, no source-sheet writes, no confirm-import execution.

## Deliverables

- Added rollout runbook: `docs/operations/feishu-cargo-migration.md`
- Linked runbook from `README.md`
- Added customer catalog regression coverage for:
  - authenticated protected image load on visible SELLABLE SKU
  - zero-stock visible SKU shown as unavailable/unorderable
  - NOT_SELLABLE submission rejection in backend integration coverage
- Updated impacted visual baselines only where the new protected-image surface intentionally changed the UI
- Hardened flaky asset-storage unit timing assertion exposed by full-suite execution
- Updated older E2E expectations from "both integrations unconfigured" to the current Task9 mixed state:
  - one `未配置` integration card
  - one `已配置` Feishu integration card
  - read-only dialog action labeled `验证只读连接`

## Verification Gates

- `npm.cmd test`
  - PASS
  - `48/48` files, `244/244` tests
- `npm.cmd run test:integration -- --maxWorkers 1`
  - PASS
  - `39/39` files, `254/254` tests
- `npm.cmd run test:e2e -- --workers 1`
  - PASS
  - `76/76` tests
- `npm.cmd run typecheck`
  - PASS
- `npm.cmd run lint`
  - PASS
- `$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_e2e_3101_test'; npm.cmd run db:migrate`
  - PASS
- `npm.cmd run build`
  - PASS
- `git diff --check`
  - PASS

## Visual Evidence

- Inspected `test-results/.../customer-catalog-desktop-chromium-expected.png`
- Inspected `test-results/.../customer-catalog-desktop-chromium-actual.png`
- Inspected `test-results/.../customer-catalog-desktop-chromium-diff.png`
- Confirmed the only intentional baseline delta was the new catalog thumbnail cell for the protected product image in `/portal/catalog`
- Updated snapshot:
  - `tests/e2e/merchant-center-visual.spec.ts-snapshots/customer-catalog-desktop-chromium-desktop-chromium-win32.png`

## Source-Write Static Audit

Token provenance evidence:

- `src/modules/feishu/outbox.ts:249`
  - resolves `sourceSpreadsheetToken` from `sourceWikiToken`
- `src/modules/feishu/outbox.ts:256-258`
  - passes `sourceSpreadsheetToken` and `targetSpreadsheetToken` separately into `syncCargoSnapshot`
- `src/modules/feishu/cargo-sync.ts:282`
  - binds `const targetSpreadsheetToken = input.config.targetSpreadsheetToken`
- `src/modules/feishu/cargo-sync.ts:298-300`
  - `writeRange(... spreadsheetToken: targetSpreadsheetToken)`
- `src/modules/feishu/cargo-sync.ts:306-310`
  - `writeImage(... spreadsheetToken: targetSpreadsheetToken)`
- `src/modules/feishu/cargo-sync.ts:324-334`
  - `setRangeStyle(... spreadsheetToken: targetSpreadsheetToken)`
- `src/modules/feishu/cargo-sync.ts:339-362`
  - `updateDimension(... spreadsheetToken: targetSpreadsheetToken)`
- `src/modules/feishu/cargo-sync.ts:367-376`
  - `createFilter(... spreadsheetToken: targetSpreadsheetToken)`
- `src/integrations/feishu/client.ts:247,327,348,363,382`
  - low-level Feishu write methods all write only to the supplied `spreadsheetToken`

Conclusion:

- Source spreadsheet token provenance is read/resolve only.
- Every sheet write path in the migration sync uses `targetSpreadsheetToken`, not `sourceWikiToken` and not the resolved `sourceSpreadsheetToken`.
- No source-write callsite was found in the migration sync path.

## Compose, Image, and Probe

- `docker compose -f compose.production.yaml config --quiet`
  - PASS with explicit local-only env:
    - `APP_ENV_FILE=.env.example`
    - `POSTGRES_DB=tongzhouxing`
    - `POSTGRES_USER=tongzhouxing_app`
    - `POSTGRES_PASSWORD=phasea-local-only-password`
    - `APP_VERSION=feishu-cargo-candidate`
- `docker build -t tongzhouxing-shop:feishu-cargo-candidate .`
  - PASS
  - image digest: `sha256:5a385b0c11b59c0343a1a2812990894738ae129b41ed7a060018b09f0e4b4aa5`
- Unprivileged disposable asset probe
  - PASS
  - disposable network: `task9-feishu-probe-net`
  - disposable Postgres: `task9-feishu-probe-postgres`
  - disposable volume: `task9_feishu_probe_assets`
  - runtime image default user created a staged asset, discarded it, committed a second asset, reopened it successfully, and volume teardown removed the disposable storage after verification
  - probe output:
    - `committedByteLength: 95`
    - `committedContentType: image/png`
    - `storageKey: sha256/d2/d2c1440ba46434ce29de676a8b50676d9be423e1ee6011f3a67f29eadb8c3baf.png`

## Audit

- `npm.cmd audit --audit-level=high`
  - PASS for threshold
  - no high or critical findings
  - remaining advisories: `4 moderate`, all through `drizzle-kit` -> `@esbuild-kit/*` -> `esbuild`

## Cleanup

- Removed exact worktree-local E2E asset directory:
  - `C:\Users\AKSSINA\Desktop\kuajinng\.worktrees\feishu-cargo-migration\.e2e-catalog-assets`
- Did not touch:
  - `pnpm-lock.yaml`
  - `pnpm-workspace.yaml`

## Residual Notes

- Docker build emits warnings about build-stage `ENV` defaults for `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `PII_ENCRYPTION_KEY`. These are build-time placeholders, not production secrets, but the warning is valid and worth follow-up if the Dockerfile is hardened later.
- Full-suite verification exposed one pre-existing timing-sensitive unit assertion in `tests/unit/feishu/asset-storage.test.ts`. The test is now deterministic under full-suite load and still checks the same safety property.

## 2026-08-13 Addendum: Read-Only Rollout Gate

- Added explicit runtime write gate `FEISHU_CARGO_WRITES_ENABLED`.
- Gate semantics are exact-match only:
  - `true` enables confirm-import, manual target sync, enqueue helpers, scheduled worker enqueue, and target-sheet writes.
  - missing, `false`, `TRUE`, `1`, or whitespace-padded values remain read-only.
- Defense-in-depth enforcement now blocks writes in:
  - `confirmCargoMigrationAction`
  - manual retry/sync action
  - enqueue helpers
  - scheduled worker loop
  - `processFeishuOutbox` before source resolution and before remote writes
- Existing queued cargo events remain `PENDING` with no remote calls and no attempt mutation while the gate is off.
- UI now keeps source discovery and read-only preflight available, but hides confirm-import and disables target sync until the gate is explicitly enabled.
- Runtime/default plumbing:
  - `.env.example` documents `FEISHU_CARGO_WRITES_ENABLED=false`
  - `compose.production.yaml` defaults `FEISHU_CARGO_WRITES_ENABLED` to `false` when omitted
  - rollout runbook now requires explicit approval plus `web`/`worker` restart to set `true`, and rollback sets `false` first

### Gate Verification

- `npm.cmd run test -- tests/unit/integrations/feishu-config.test.ts tests/unit/feishu/actions.test.ts tests/unit/feishu/cargo-migration-panel.test.tsx`
  - PASS
  - `3/3` files, `23/23` tests
- `npm.cmd run test:integration -- tests/integration/feishu/cargo-sync.test.ts tests/integration/feishu/outbox.test.ts tests/integration/feishu/source-protection.test.ts tests/integration/feishu/migration-service.test.ts`
  - PASS
  - `4/4` files, `32/32` tests
- `npm.cmd run typecheck`
  - PASS
- `npm.cmd run lint`
  - PASS
- `npm.cmd run build`
  - PASS
- `docker compose -f compose.production.yaml --env-file .env.example config --quiet`
  - PASS with local-only overrides for `APP_VERSION`, `POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`
- `git diff --check`
  - PASS
