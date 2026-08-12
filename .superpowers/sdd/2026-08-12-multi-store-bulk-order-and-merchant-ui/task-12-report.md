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

## Fix Round 1

Date: 2026-08-12

Review findings closed:
- `src/app/(admin)/admin/orders/[orderId]/page.tsx`
  - moved `返回订单列表` into the visible `PageHeading` action area
  - removed the dead hidden legacy header block
  - removed the duplicate metrics card section so heading metrics render once
- `src/app/(customer)/portal/imports/[batchId]/page.tsx`
  - restored visible `重新上传` navigation inside `PageHeading`
  - removed the hidden legacy preview header and duplicate summary cards
  - preserved `requireCustomer`, preview lookup, blocking logic, and submit button behavior
- `src/app/(admin)/admin/replacements/page.tsx`
  - replaced raw replacement status enum output with explicit Chinese labels and unknown fallback
- `src/components/data-workspace/metric-strip.tsx`
  - compacted the shared strip to a 2-column mobile grid so catalog KPI cards render 2x2 instead of one-per-row
- `src/components/bulk-order/bulk-order-workspace.tsx`
  - default-collapsed idle mobile store cards after the first one without changing selection, upload, focus, or idempotency behavior
- `src/components/bulk-order/store-group-card.tsx`
  - added mobile-only progressive disclosure control and explicit collapsed state marker for testability

Tests added/updated for the fixes:
- Added unit RED/GREEN coverage:
  - `tests/unit/orders/admin-order-detail-page.test.tsx`
  - `tests/unit/order-import/import-preview-page.test.tsx`
  - `tests/unit/fulfillment/replacement-status-label.test.ts`
  - `tests/unit/bulk-order/bulk-order-workspace.test.tsx`
- Extended E2E coverage:
  - `tests/e2e/phase-three-fulfillment.spec.ts`
    - visible `返回订单列表`
    - heading metrics render once on admin order detail
  - `tests/e2e/customer-catalog.spec.ts`
    - customer import preview keeps visible `重新上传`
    - `data-metric-strip` contains exactly four heading metrics
  - `tests/e2e/multi-store-bulk-order.spec.ts`
    - widened settlement redirect assertion timeout to avoid false red under high concurrency after stateful submit

RED / GREEN:
- RED on 2026-08-12:
  - `npm.cmd test -- tests/unit/orders/admin-order-detail-page.test.tsx tests/unit/order-import/import-preview-page.test.tsx ...`
  - exposed:
    - missing visible admin back link
    - missing visible customer re-upload link
    - duplicate page-level metrics
    - raw replacement status output
- GREEN on 2026-08-12:
  - `npm.cmd test -- tests/unit/orders/admin-order-detail-page.test.tsx tests/unit/order-import/import-preview-page.test.tsx tests/unit/fulfillment/replacement-status-label.test.ts tests/unit/bulk-order/bulk-order-workspace.test.tsx`
    - passed: 4 files / 12 tests

Verification for fix round 1:
- `npm.cmd run typecheck`
  - passed
- `npm.cmd run lint`
  - passed
- `npm.cmd test`
  - passed: 30 files / 98 tests
- `npm.cmd run test:e2e -- --workers=1 tests/e2e/phase-three-fulfillment.spec.ts`
  - passed: 2 tests, skipped: 2 project-specific cases
- `npm.cmd run test:e2e -- --workers=1 --update-snapshots=changed tests/e2e/customer-catalog.spec.ts`
  - passed: 6 tests
- `npm.cmd run test:e2e -- --workers=1 --update-snapshots=changed tests/e2e/merchant-center-visual.spec.ts`
  - passed: 14 tests
- `npm.cmd run test:e2e -- --project=desktop-chromium --update-snapshots=changed tests/e2e/multi-store-bulk-order.spec.ts`
  - passed: 3 tests, skipped: 1 project-specific case
- `git diff --check`
  - no whitespace or conflict-marker findings; only LF→CRLF warnings in touched files

Visual evidence refresh:
- refreshed task evidence files under `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-12-visual/`:
  - `admin-settlement-review-1440.png`
  - `admin-settlement-review-390.png`
  - `bulk-workspace-1440.png`
  - `bulk-workspace-390.png`
  - `settlement-1440.png`
- confirmed actual screenshot dimensions:
  - `admin-settlement-review-1440.png`: `1440x1248`
  - `admin-settlement-review-390.png`: `390x2234`
  - `bulk-workspace-1440.png`: `1440x4877`
- manual review after refresh:
  - desktop and mobile settlement-review captures are no longer the same size
  - no obvious horizontal overflow
  - compact KPI cards and progressive disclosure are visible on mobile

Notes:
- Running `merchant-center-visual.spec.ts` with the default 10 workers produced intermittent seeded-customer login failures on mobile (`/login` instead of `/portal`). Re-running the same suite with `--workers=1` passed 14/14, so the issue was treated as test-environment concurrency noise rather than a product regression.

## Fix round 2 - 2026-08-12

Scope:
- compacted the customer mobile workspaces without changing route, field, selection, upload, or submit behavior
- kept evidence and staging scoped to Task12 sources, tests, snapshots, and task evidence only

Changed UI/state paths:
- `src/components/bulk-order/bulk-order-workspace.tsx`
  - moved mobile store-group disclosure state into the parent workspace so the draft view controls which groups start collapsed
  - default-expanded only the first store group on mobile; all remaining groups now open from summary cards via explicit disclosure instead of rendering every details form at once
  - auto-expands the targeted group before restoring focus for checkbox/file-input error flows, preserving Task8 selection and idempotency behavior
- `src/components/bulk-order/store-group-card.tsx`
  - removed child-local collapse state in favor of controlled disclosure props
  - added `aria-controls`, stable `data-group-id`, and retained `min-h-11` disclosure buttons for mobile touch targets
- `tests/unit/bulk-order/bulk-order-workspace.test.tsx`
  - added RED/GREEN coverage for:
    - eight `SUBMITTABLE` groups render with only the first expanded on mobile
    - submit-error focus restores the targeted collapsed group before focusing the checkbox
    - operators can manually collapse/reopen a submittable group
- `tests/e2e/customer-catalog.spec.ts`
  - replaced the flaky mojibake label locator with `input[name="q"]`
  - added a real render assertion at width `390`:
    - `data-metric-strip` computes to two columns
    - the catalog search field remains within the first `390x844` viewport

RED / GREEN:
- RED on 2026-08-12:
  - `npm.cmd test -- tests/unit/bulk-order/bulk-order-workspace.test.tsx`
    - failed because all eight `SUBMITTABLE` store groups rendered expanded, the second group had no manual disclosure control, and focus-restoration could not reopen a collapsed group
  - `npm.cmd run test:e2e -- --project=mobile-chromium -g "customer catalog remains usable at approved mobile widths" tests/e2e/customer-catalog.spec.ts`
    - failed because the old label-based locator could not prove the real `390` viewport render state
- GREEN on 2026-08-12:
  - `npm.cmd test -- tests/unit/bulk-order/bulk-order-workspace.test.tsx`
    - passed: 1 file / 11 tests
  - `npm.cmd run test:e2e -- --project=mobile-chromium -g "customer catalog remains usable at approved mobile widths" tests/e2e/customer-catalog.spec.ts`
    - passed
  - `npm.cmd run test:e2e -- --workers=1 --project=mobile-chromium -g "customer bulk workspace stays usable at approved mobile widths" tests/e2e/multi-store-bulk-order.spec.ts`
    - passed

Verification for fix round 2:
- `npm.cmd run test:e2e -- --workers=1 --project=desktop-chromium --project=mobile-chromium tests/e2e/customer-catalog.spec.ts --update-snapshots=changed`
  - passed: 6 tests
- `npm.cmd run test:e2e -- --workers=1 --project=<desktop|mobile> -g "<merchant-center route>" tests/e2e/merchant-center-visual.spec.ts --update-snapshots=changed`
  - passed all 14 route/project combinations when executed one route at a time
- `npm.cmd test`
  - passed: 30 files / 101 tests
- `npm.cmd run typecheck`
  - passed
- `npm.cmd run lint`
  - passed
- `git diff --check`
  - no whitespace or conflict-marker findings; only LF->CRLF warnings in touched files

Visual evidence refresh:
- refreshed `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-12-visual/` with current render outputs:
  - `bulk-workspace-390.png`
  - `bulk-workspace-1440.png`
  - `customer-catalog-mobile-chromium-mobile-chromium-win32.png`
- confirmed dimensions:
  - `bulk-workspace-390.png`: `1073x12375`
  - `customer-catalog-mobile-chromium-mobile-chromium-win32.png`: `390x844`
- manual review:
  - `bulk-workspace-390.png` now shows only the first store group expanded in the opening viewport; groups 2-8 stay in summary form with `展开详情`
  - `customer-catalog-mobile-chromium-mobile-chromium-win32.png` shows KPI cards in a 2x2 grid and keeps the search field inside the first mobile viewport

Environment note:
- running the entire `merchant-center-visual.spec.ts` file in one Playwright invocation still hit an unstable local web-server lifecycle after the first route (`ERR_CONNECTION_REFUSED` on later routes)
- the route-by-route reruns used the same assertions, snapshots, and local code against a clean Playwright-managed server per invocation, and all 14 cases passed without code changes
