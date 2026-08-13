# Task 2 Report: Feishu Source/Target Isolation

## Implementation

- Split Feishu configuration into source-only and target-only fields in `src/integrations/feishu/config.ts`, with strict target-pair validation, optional bot chat, and production-only API base enforcement.
- Added `src/integrations/feishu/tokens.ts` to hash tokens with SHA-256 and compare source/target spreadsheet identities without exposing raw values.
- Rewired cargo sync in `src/modules/feishu/cargo-sync.ts` to resolve the source wiki only for safety validation and to write exclusively to the configured target spreadsheet/token pair.
- Gated worker and action behavior in `src/jobs/worker.ts` and `src/modules/feishu/actions.ts` so source-only config supports preflight, manual/background writes stay disabled without a complete target pair, bot processing is independent of cargo sync, and `FEISHU_API_BASE_URL` alone does not turn Feishu “on”.
- Suppressed cargo event production in `src/modules/feishu/outbox.ts` unless the full writer configuration is valid, preventing pending-event backlog in source-only deployments.
- Updated the admin integrations page and `.env.example` to reflect the new source/target contract.

## Files

- Modified: `.env.example`
- Modified: `src/app/(admin)/admin/system/integrations/page.tsx`
- Modified: `src/integrations/feishu/config.ts`
- Added: `src/integrations/feishu/tokens.ts`
- Modified: `src/jobs/worker.ts`
- Modified: `src/modules/feishu/actions.ts`
- Modified: `src/modules/feishu/cargo-sync.ts`
- Modified: `src/modules/feishu/outbox.ts`
- Added: `tests/unit/integrations/feishu-config.test.ts`
- Modified: `tests/integration/feishu/cargo-sync.test.ts`
- Modified: `tests/integration/feishu/outbox.test.ts`

## Tests

- RED:
  - `npm.cmd test -- tests/unit/integrations/feishu-config.test.ts`
    - Failed because the new config helpers and target/source split did not exist yet.
  - `npm.cmd run test:integration -- tests/integration/feishu/cargo-sync.test.ts`
    - Failed because cargo sync still resolved and wrote through the source wiki spreadsheet.
  - `npm.cmd run test:integration -- tests/integration/feishu/outbox.test.ts`
    - Failed because writer gating and new config shape were not implemented.
- GREEN:
  - `npm.cmd test -- tests/unit/integrations/feishu-config.test.ts`
  - `npm.cmd run test:integration -- tests/integration/feishu/cargo-sync.test.ts tests/integration/feishu/outbox.test.ts`
  - `npm.cmd run typecheck`
  - `npm.cmd run lint`
  - `git diff --check`

## TDD Evidence

- Wrote the new unit config contract first, including source-only acceptance, partial-target rejection, API base override rules, and source-vs-target collision rejection.
- Wrote integration regressions first for target-only writing, source/target collision prevention, and writer-disabled pending behavior.
- Wrote integration regressions first for target-only writing, source/target collision prevention, and writer-disabled enqueue suppression.
- Verified the initial RED failures before implementing the config split and guarded write path.
- Re-ran the same focused suites after implementation to confirm GREEN.

## Concerns

- `git status` shows unrelated untracked files `pnpm-lock.yaml` and `pnpm-workspace.yaml`; they were not modified or staged by this task.
- `git diff --check` is clean for content, but Git warns several touched files will normalize from LF to CRLF on future checkout in this Windows worktree.
- Live environment verification still needed for a non-production fake Feishu server using `FEISHU_API_BASE_URL`, because this task intentionally did not contact a real Feishu tenant.

## Repair Round 1 (2026-08-13)

### Findings Addressed

- Important: cargo enqueue helpers no longer swallow invalid Feishu runtime config. Only no-config and valid source-only config disable the writer; partial target or other invalid config now throws a clear configuration error.
- Important: `FEISHU_API_BASE_URL` override is now allowed only when `NODE_ENV` is explicitly `development` or `test`. Missing, `prod`, `staging`, and `production` now reject the override.
- Minor: `docs/operations/local-development.md` now documents the source/target pair contract and source-only preflight behavior instead of the old first-sheet fallback.

### RED

- `npm.cmd test -- tests/unit/integrations/feishu-config.test.ts`
  - Failed because `readFeishuApiBaseUrl` still allowed overrides when `NODE_ENV` was missing or non-whitelisted.
- `npm.cmd run test:integration -- tests/integration/feishu/outbox.test.ts`
  - Failed because `enqueueCargoSyncEvent()` still resolved successfully under partial target config and silently acted like writer-disabled.

### GREEN

- `npm.cmd test -- tests/unit/integrations/feishu-config.test.ts`
  - Passed: `1 passed, 6 tests`
- `npm.cmd run test:integration -- tests/integration/feishu/cargo-sync.test.ts tests/integration/feishu/outbox.test.ts`
  - Passed: `2 passed, 8 tests`
- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `git diff --check`

### Files

- Modified: `src/integrations/feishu/config.ts`
- Modified: `src/modules/feishu/outbox.ts`
- Modified: `tests/unit/integrations/feishu-config.test.ts`
- Modified: `tests/integration/feishu/outbox.test.ts`
- Modified: `docs/operations/local-development.md`
