## Task 12 Report

Date: 2026-08-12

Implemented:
- Migrated shared merchant workspace primitives and shells across admin/customer routes:
  - `src/app/globals.css`
  - `src/components/layout/admin-shell.tsx`
  - `src/components/layout/customer-shell.tsx`
  - `src/components/layout/merchant-topbar.tsx`
  - `src/components/layout/page-heading.tsx`
  - `src/components/layout/workspace-panel.tsx`
  - `src/components/data-workspace/metric-strip.tsx`
  - `src/components/data-workspace/data-workspace-toolbar.tsx`
  - `src/components/data-workspace/responsive-data-table.tsx`
  - `src/components/data-workspace/exception-queue.tsx`
- Reworked admin workspace pages into the approved merchant-center visual system without changing route, query, field, or action behavior:
  - `src/app/(admin)/admin/page.tsx`
  - `src/app/(admin)/admin/orders/page.tsx`
  - `src/app/(admin)/admin/orders/[orderId]/page.tsx`
  - `src/app/(admin)/admin/inventory/page.tsx`
  - `src/app/(admin)/admin/settlement/page.tsx`
  - `src/app/(admin)/admin/settlement-batches/page.tsx`
  - `src/app/(admin)/admin/accounts/page.tsx`
  - `src/app/(admin)/admin/customers/page.tsx`
  - `src/app/(admin)/admin/customers/[customerId]/page.tsx`
  - `src/app/(admin)/admin/catalog/page.tsx`
  - `src/app/(admin)/admin/bulk-orders/page.tsx`
  - `src/app/(admin)/admin/bulk-orders/[draftId]/page.tsx`
  - `src/app/(admin)/admin/replacements/page.tsx`
  - `src/app/(admin)/admin/reports/page.tsx`
  - `src/app/(admin)/admin/notifications/page.tsx`
  - `src/app/(admin)/admin/system/health/page.tsx`
  - `src/app/(admin)/admin/system/integrations/page.tsx`
  - `src/app/(admin)/admin/system/audit/page.tsx`
- Reworked customer workspace pages into the same system while preserving touch targets and route behavior:
  - `src/app/(customer)/portal/page.tsx`
  - `src/app/(customer)/portal/catalog/page.tsx`
  - `src/app/(customer)/portal/bulk-orders/page.tsx`
  - `src/app/(customer)/portal/imports/new/page.tsx`
  - `src/app/(customer)/portal/imports/[batchId]/page.tsx`
  - `src/app/(customer)/portal/orders/page.tsx`
  - `src/app/(customer)/portal/orders/[orderId]/page.tsx`
  - `src/app/(customer)/portal/settlements/[settlementId]/page.tsx`
  - `src/app/(customer)/portal/wallet/page.tsx`
- Rebuilt shared bulk/settlement workspace flows so page-level visuals match the merchant workspace while keeping Task8/Task9 behavior intact:
  - `src/components/bulk-order/bulk-order-workspace.tsx`
  - `src/components/settlement/admin-settlement-review.tsx`
- Fixed the post-migration regression where the multi-store draft summary and add-store controls were accidentally hidden inside `bulk-order-workspace`; restored a visible workspace control block without reverting selection, focus, or idempotency logic.
- Kept all state labels customer-facing in Chinese and avoided raw enum exposure in settlement/account/customer surfaces.

Tests added/updated:
- Added `tests/e2e/merchant-center-visual.spec.ts`
  - verifies shared topbar, `data-page-heading`, `data-metric-strip`, workspace panels, no horizontal overflow, and axe serious/critical `0`
  - covers 7 representative routes across desktop and 390-width mobile:
    - `/admin`
    - `/admin/orders`
    - `/admin/inventory`
    - `/admin/settlement`
    - `/portal`
    - `/portal/catalog`
    - `/portal/bulk-orders`
- Updated visual baselines:
  - `tests/e2e/merchant-center-visual.spec.ts-snapshots/*`
  - `tests/e2e/customer-catalog.spec.ts-snapshots/customer-catalog-desktop-chromium-desktop-chromium-win32.png`
  - `tests/e2e/customer-catalog.spec.ts-snapshots/customer-catalog-mobile-chromium-mobile-chromium-win32.png`
- Updated unit coverage to align assertions with the migrated merchant workspace copy and structure:
  - `tests/unit/accounts/account-management.test.tsx`
  - `tests/unit/customers/customer-management-pages.test.tsx`
  - `tests/unit/settlement/admin-settlement-review.test.tsx`
  - `tests/unit/settlement/customer-settlement-page.test.tsx`

RED / GREEN:
- RED command on 2026-08-12:
  - `npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers=1`
  - failed on missing merchant workspace screenshot baselines and pre-migration visual structure differences
- Additional RED checkpoint on 2026-08-12:
  - `npm.cmd run test:e2e -- tests/e2e/multi-store-bulk-order.spec.ts --project=desktop-chromium --workers=1`
  - failed because the visible `8 个店铺可提交` summary was hidden with the legacy header block
- GREEN commands on 2026-08-12:
  - `npm.cmd run test:e2e -- tests/e2e/multi-store-bulk-order.spec.ts --project=desktop-chromium --workers=1`
  - `npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers=1 --update-snapshots`
  - `npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers=1`

Verification:
- `npm.cmd run typecheck`
  - passed
- `npm.cmd run lint`
  - passed
- `npm.cmd test`
  - passed: 27 files / 93 tests
- `npm.cmd run test:e2e -- tests/e2e/admin-management.spec.ts --project=desktop-chromium --workers=1`
  - passed: 2 tests
- `npm.cmd run test:e2e -- tests/e2e/phase-two-payment.spec.ts --project=desktop-chromium --workers=1`
  - passed: 1 test, skipped: 1 project-specific mobile case
- `npm.cmd run test:e2e -- tests/e2e/multi-store-bulk-order.spec.ts --workers=1`
  - passed: 6 tests, skipped: 2 project-specific cases
- `npm.cmd run test:e2e -- tests/e2e/customer-catalog.spec.ts --workers=1 --update-snapshots`
  - passed: 4 tests
- `npm.cmd run test:e2e -- tests/e2e/customer-catalog.spec.ts --workers=1`
  - passed: 4 tests
- `npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers=1 --update-snapshots`
  - passed: 14 tests
- `npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --workers=1`
  - passed: 14 tests
- `rg -n --fixed-strings "font-family" src`
  - only remaining match: `src/app/globals.css` product token declaration
- `rg -n --fixed-strings "font-[" src`
  - no matches
- `git diff --check`
  - no whitespace or conflict-marker findings; only LF→CRLF warnings in touched files
- `node C:\\Users\\AKSSINA\\.agents\\skills\\impeccable\\scripts\\detect.mjs --json ...`
  - detector output: `[]`

Manual visual review:
- Reviewed representative Task12 evidence screenshots after capture:
  - `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-12-visual/admin-orders-desktop-chromium-desktop-chromium-win32.png`
  - `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-12-visual/customer-bulk-orders-mobile-chromium-mobile-chromium-win32.png`
  - `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-12-visual/admin-settlement-review-390.png`
- Confirmed on those samples:
  - shared page heading and metric strip are visible
  - no obvious horizontal overflow
  - mobile controls remain comfortably tappable
  - status copy is Chinese and no raw enum text is exposed

Heading coverage note:
- Static admin/customer page scan now has one direct `PageHeading` exception:
  - `src/app/(admin)/admin/settlement-batches/[settlementId]/page.tsx`
- That route intentionally receives its runtime `data-page-heading` from shared component `src/components/settlement/admin-settlement-review.tsx`.

Evidence bundle:
- Task12 visual bundle written to:
  - `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-12-visual/`
- Included artifacts:
  - 14 merchant workspace desktop/mobile baseline screenshots from `merchant-center-visual`
  - representative multi-store and settlement flow captures:
    - `bulk-workspace-1440.png`
    - `bulk-workspace-390.png`
    - `settlement-1440.png`
    - `admin-settlement-review-1440.png`
    - `admin-settlement-review-390.png`

Notes:
- `tests/e2e/merchant-center-visual.spec.ts` uses stable viewport screenshots instead of `fullPage` screenshots because seeded order/catalog tables can grow across runs and would otherwise cause non-product baseline drift.
- Existing unrelated dirt remained untouched and was not staged into Task12:
  - `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-10-report.md`
  - `visual-review/screenshots/fix-round1/*`
- Playwright web-server output still emits expected access-denial stack traces for customer attempts to hit admin-only routes and occasional `MaxListenersExceededWarning` lines from the dev server; no assertions failed because of them.
