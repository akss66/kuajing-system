# Task 8 Report

## Scope Delivered

- Added customer bulk-order entry, list, draft workspace, and unified settlement pages.
- Added client components for bulk workspace, per-store group cards, sticky summary bar, and settlement payment form.
- Connected the UI to existing `src/modules/bulk-order/actions.ts` and `src/modules/settlement/actions.ts`.
- Extended reads needed by the approved UI using existing query/service layers:
  - `listBulkDrafts`
  - `getBulkWorkspaceDraft`
  - `getCustomerSettlementDetail`
  - wallet hold history in `getCustomerWalletView`
- Updated customer shell and wallet/home entry points for the new flow.

## TDD Record

- RED established first with `tests/unit/bulk-order/bulk-order-workspace.test.tsx`.
- Unit test then brought to GREEN.
- E2E also started red:
  - first on local auth cookie behavior over HTTP
  - then on TEMU workbook header fixture mismatch
  - then on missing inventory seed causing all groups to be `BLOCKED_INVENTORY`
- E2E brought to GREEN after the minimal fixture/auth fixes.

## Verification

- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `npm.cmd test`
- `npm.cmd run test:e2e -- multi-store-bulk-order.spec.ts`
- `node C:\\Users\\AKSSINA\\.agents\\skills\\impeccable\\scripts\\detect.mjs --json 'src\\app\\(customer)\\portal\\bulk-orders' 'src\\app\\(customer)\\portal\\settlements' 'src\\components\\bulk-order' 'src\\components\\settlement' 'src\\components\\layout\\customer-shell.tsx' 'src\\app\\(customer)\\portal\\page.tsx' 'src\\app\\(customer)\\portal\\wallet\\page.tsx'`

## Detector Result

- Detector returned `[]`.

## Minimal Supporting Changes

- `src/modules/identity/auth.ts`
  - made cookie `secure` conditional on `BETTER_AUTH_URL` using HTTPS so local Playwright login can establish a session on `http://127.0.0.1:3000`
- `tests/e2e/multi-store-bulk-order.spec.ts`
  - reused `TEMU_EXPORT_HEADERS`
  - seeded `inventoryBalances` so the workflow is actually submittable

## Concerns

- I did not finish the separate one-off screenshot artifact capture pass because the temporary shell-driven capture script was blocked by the local command policy wrapper. Functional mobile coverage still passed in Playwright at 360/390/430 with no page-level horizontal overflow assertion regression.
- `next-env.d.ts` was touched by local Next dev behavior during verification; it is not part of the intended product change and should be excluded from the commit if still shown by git as a pure line-ending/worktree artifact.

## Fix Round 1 — Phase A Behavior

### RED evidence

- `npm.cmd test -- tests/unit/bulk-order/bulk-order-workspace.test.tsx tests/unit/bulk-order/submit-bulk-draft-action.test.ts tests/unit/settlement/settlement-payment-form.test.tsx tests/unit/settlement/customer-settlement-page.test.tsx`
  initially failed for workspace refresh selection, first-error focus, client idempotency replay validation, and settlement label/anchor coverage.

### GREEN evidence

- `npm.cmd test -- tests/unit/bulk-order/bulk-order-workspace.test.tsx tests/unit/bulk-order/submit-bulk-draft-action.test.ts tests/unit/settlement/settlement-payment-form.test.tsx tests/unit/settlement/customer-settlement-page.test.tsx` — 4 files, 11 tests passed.
- `npm.cmd run typecheck` — passed.
- `npm.cmd run lint` — passed.

### Behavior covered

- Refreshes prune non-submittable selections, auto-select newly submittable groups, and retain explicit cancellation of still-submittable groups.
- Validation errors focus the related store selector, file input, first selectable group, payment note, or withdrawal-reason control while retaining alerts.
- The browser creates a UUID once per canonical submit payload and reuses it for retries; the action validates and forwards that key.
- Settlement enums use customer-facing Chinese labels; the heading has a visible `跳到付款声明` link to a focusable payment form.

## Fix Round 1 — Phase B Visual and Browser Acceptance

### Browser evidence

- Isolated Playwright Chromium verified the workspace at 1440px, 390px, and 360px: no document horizontal overflow and every visible submit CTA measured at least 44px high.
- The compact summary measured within the acceptance bounds: desktop 96–120px, mobile no more than 96px. At mobile widths the initial row stays collapsed and group work begins in the first viewport; full metrics remain available through `查看汇总`.
- The isolated mobile console collection recorded no React hydration errors (including server-rendered HTML/text-content mismatch patterns). No hydration suppression was added.
- Settlement verification covered Chinese status labels plus the visible `跳到付款声明` link and focusable `#settlement-payment-form` target.

### Screenshots

- `visual-review/screenshots/fix-round1/bulk-workspace-1440.png`
- `visual-review/screenshots/fix-round1/bulk-workspace-390.png`
- `visual-review/screenshots/fix-round1/bulk-workspace-360.png`
- `visual-review/screenshots/fix-round1/settlement-1440.png`

### Verification

- `npm.cmd run test:e2e -- tests/e2e/multi-store-bulk-order.spec.ts` — 2 passed, 2 correctly project-skipped.
- Impeccable detector over changed customer workspace and settlement surfaces — `[]`.

## Fix Round 2 — Accessibility Coverage Completion

### RED/GREEN evidence

- RED: local `vitest.cmd` ran the new target assertions. The `PENDING` payment-declaration case failed because `#settlement-payment-form` was absent. The selection refresh assertion was immediately green because the prior refresh implementation already retained explicit deselection; this round adds direct regression coverage for that contract.
- GREEN: `node_modules\\.bin\\vitest.cmd run tests/unit/bulk-order/bulk-order-workspace.test.tsx tests/unit/settlement/settlement-payment-form.test.tsx tests/unit/settlement/customer-settlement-page.test.tsx` — 3 files, 13 tests passed.
- GREEN: `node_modules\\.bin\\playwright.cmd test tests/e2e/multi-store-bulk-order.spec.ts --project=mobile-chromium --grep "approved mobile widths"` — 1 passed, checking 360px, 390px, and 430px.

### Coverage completed

- A direct workspace rerender test proves a manual deselection survives while a blocked group is pruned and a newly submittable group defaults to selected.
- The payment declaration id/tab stop now belongs to its always-present outer wrapper, so the skip target exists and can be focused for both no-claim and `PENDING` claim states without duplicate ids.
- Mobile browser coverage restores the 430px loop and continues to assert no horizontal overflow, CTA minimum height, compact-summary bounds, and no React hydration console errors at every approved width.

### Notes

- The detector was intentionally not rerun: this round adds accessibility behavior and coverage only, without a new visual system change.
- `pnpm.cmd` was blocked by the repository's minimum-release-age supply-chain policy before Vitest could start; direct local test binaries were used for the targeted RED/GREEN loop.
