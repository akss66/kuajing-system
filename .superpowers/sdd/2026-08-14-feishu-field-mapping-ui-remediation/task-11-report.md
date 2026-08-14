# Task 11 implementation report

## Outcome and scope

- Added deterministic browser acceptance for the two inventory views, row-scoped `+ / - 调整`, structured defaults and warnings, six preview facts, locked-stock rejection, note persistence, stocktake/no-change behavior, automatic/manual source distinction, all movement filters/reset/pagination, and order/replacement/migration/stocktake relations.
- The fixture uses a derived E2E database only and includes locked inventory, system and manual shipment rows, Feishu migration history, a stocktake batch, long SKU/name/reason/remark/operator values, and 28 movement rows so pagination is observable.
- Covered a keyboard-only mobile adjustment flow and the exact 1440x900, 1920x1080, 430x900, 390x844, and 360x800 viewport matrix.
- Added unmasked snapshot/drawer/movement screenshots, axe serious/critical checks, document and cell-internal overflow checks, semantic desktop-table/mobile-card fact parity, touch-target checks, long-content containment, and console/pageerror/hydration collectors installed before navigation.
- Updated the existing management and responsive suites only for the approved inventory route/contracts and the current accessible adjustment name. Updated only the existing inventory merchant-center baselines.
- Did not deploy, write to Feishu, enable cargo writes, touch production data, or change the fulfillment/authorization/settlement/tenant/permission semantics.

## Database safety

- Before the first migration/reset, read-only identity verification returned `tongzhouxing_e2e_3101_test`; its name contains `e2e` and ends in `_test`.
- The database initially had 21 migration records and no `inventory_stocktake_batches` table. The repository's forward-only `scripts/prepare-test-database.ts` applied migration 0021 only after the guard.
- Final read-only verification returned `{"database":"tongzhouxing_e2e_3101_test","migrations":22,"stocktakeTableRows":1}`.
- `playwright.config.ts` fixes `FEISHU_CARGO_WRITES_ENABLED` to `"false"`. No source/target Feishu network write path was invoked.

## Witnessed RED -> GREEN

### Inventory browser behavior and URL reset

- The initial behavior suite produced 1 pass, 1 failure, and 1 not run in 10.2 minutes while the first pointer selector still targeted the visually wrapped radio input. Replacing only that selector with the visible label exposed the real behavior path.
- The completed browser flow then exposed a product defect: after `重置筛选`, URL props were clear but uncontrolled inputs retained the old movement type, so a source-only submit resubmitted that stale type. Task 10 supplied focused RED/GREEN fix `f713b5b`.
- Fresh focused GREEN after that fix: `2/2 passed` in `17.8s`, including reset followed by a source-only submit with no old type in the URL.

### Long desktop table content

- Manual inspection of the initial baselines found the long inventory name crossing the total/locked/available columns and long movement facts being clipped. The browser assertion was tightened from whole-row containment to cell-internal overflow and adjacent-fact separation.
- Meaningful browser RED: `1 failed` in `15.0s`; the 1440 snapshot name cell had `740px` horizontal internal overflow (expected `<=1px`).
- Task 10 supplied focused CSS fix `eeb4954`. The strengthened name/reason/operator cell assertions passed at both desktop widths, with the right-most source/time/relation facts visible.

### Existing-suite compatibility

- The first related suite run produced `11/12 passed` in `2.3m`; the only failure was the obsolete accessible name `调整库存` in `admin-management.spec.ts`.
- The selector-only compatibility fix targeted the approved `+ / - 调整 <SKU>` name. Focused GREEN was `1/1 passed` in `16.4s`; the full related rerun was `12/12 passed` in `1.9m`.

## Visual, accessibility, and runtime evidence

- Initial visual baseline creation: `21/21 passed` in `1.0m`; 15 new inventory baselines plus the affected existing inventory merchant-center baselines were written without masks.
- After the real table defect was fixed, the controller-approved single confirmation refresh passed `21/21` in `1.0m`. It rewrote the six desktop inventory matrix images and the affected desktop merchant inventory baseline; there was no third update.
- Final full visual run without `--update-snapshots`: `21/21 passed` in `58.7s`.
- Across the five exact inventory viewports, 15 axe scans reported zero serious/critical violations and 15 document overflow checks stayed within `1px`. Long desktop cell overflow, adjacent-column overlap, mobile card containment, table/card fact parity, and 44px touch targets all passed.
- Console errors, uncaught page errors, and hydration errors were each `[]` for the inventory matrix. Screenshots use deterministic fixtures/timestamps and `animations: "disabled"`; there are no masks or arbitrary waits.
- Manual original-resolution review covered snapshot/drawer/movements at 1440, 390, and 360. The fixed desktop tables wrap within columns; mobile cards and drawers retain readable long facts with no overlap or horizontal spill.
- The Impeccable detector was run exactly once after the final UI fix using the required command. Exit code was `0` and JSON output was `[]`.

## Screenshot artifacts

All 15 inventory artifacts are under:

`C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\tests\e2e\inventory-movements.spec.ts-snapshots`

The directory contains `inventory-snapshot-*`, `inventory-adjustment-*`, and `inventory-movements-*` for each of 1440x900, 1920x1080, 430x900, 390x844, and 360x800. Representative manually inspected files:

- `C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\tests\e2e\inventory-movements.spec.ts-snapshots\inventory-snapshot-1440x900-desktop-chromium-win32.png`
- `C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\tests\e2e\inventory-movements.spec.ts-snapshots\inventory-movements-1440x900-desktop-chromium-win32.png`
- `C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\tests\e2e\inventory-movements.spec.ts-snapshots\inventory-adjustment-390x844-desktop-chromium-win32.png`
- `C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\tests\e2e\inventory-movements.spec.ts-snapshots\inventory-movements-360x800-desktop-chromium-win32.png`

## Final verification

```powershell
npm.cmd run test:e2e -- tests/e2e/inventory-movements.spec.ts tests/e2e/merchant-center-visual.spec.ts --grep 'visual matrix|shared merchant-center visual structure'
# 21/21 passed, 58.7s, no snapshot update

npm.cmd run test:e2e -- tests/e2e/inventory-movements.spec.ts tests/e2e/admin-management.spec.ts tests/e2e/ui-v2-responsive.spec.ts --grep-invert 'visual matrix'
# 12/12 passed, 1.9m

npm.cmd run typecheck
npm.cmd exec eslint -- tests/e2e/inventory-movements.spec.ts tests/e2e/admin-management.spec.ts tests/e2e/merchant-center-visual.spec.ts tests/e2e/ui-v2-responsive.spec.ts
git diff --check
# all exit 0
```

- Static scan found no `waitForTimeout`, screenshot mask, or arbitrary `setTimeout` in the four affected E2E files.
- No `.e2e-*` temporary asset directory remains.

## Residual risks

- These browser projects exercise Chromium desktop/mobile only; cross-engine rendering remains outside the configured repository matrix.
- Full repository unit/integration/build and whole-branch review remain the parent Task 12/branch-finalization responsibility; this task intentionally did not rerun or repair unrelated suites.
- Mobile movement pages are intentionally long because the accepted page size is 20 cards, but pagination, readable facts, touch targets, and horizontal containment are verified.
