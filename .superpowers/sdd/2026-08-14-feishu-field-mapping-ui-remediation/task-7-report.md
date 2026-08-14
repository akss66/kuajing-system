# Task 7 — field-aligned E2E acceptance report

## Environment safety

- E2E database was derived from the isolated Playwright port and verified read-only as `tongzhouxing_e2e_3101_test` before mutation; it contains the required `test`/`e2e` marker.
- `jifeng_authorization_attempts` was initially absent. The repository's forward-only `npm.cmd exec -- tsx scripts/prepare-test-database.ts` command was run only with the verified E2E database URL. The same database then reported 21 migrations and the expected table.
- `FEISHU_CARGO_WRITES_ENABLED=false` remained unchanged. Acceptance asserts an empty integration outbox and zero source/target fake-server writes.
- Temporary `C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\.e2e-catalog-assets` was path-validated inside the workspace, removed, and confirmed absent before staging.

## TDD evidence

- Initial unchanged focused RED: 19 tests; 10 passed, 7 failed, 2 did not run. Failures captured the obsolete 74-SKU fixture, old status/count copy, and old search accessible name.
- Fixture/selector-only work added deterministic 74 source sequences, 140 unique SKUs, 140 images, the TZX-034 trio, a 100+ character specification, long email, ¥0.325 procurement and ¥1.366 cargo prices, manual-unavailable-with-stock, and sold-out states.
- Final functional command (no snapshot update): 18/18 passed in 3.6 minutes.
- Visual update confirmation: 25/25 passed. Final visual command without snapshot update: 25/25 passed in 1.1 minutes.
- `npm.cmd run typecheck`: passed. `git diff --check`: passed. (The repository has no `check:diff` npm script.)

## Acceptance matrix

- Exact viewports: 1440x900, 1920x1080, 430x900, 390x844, 360x800.
- Covered admin catalog, admin accounts/navigation, customer catalog, and Feishu read-only confirmation.
- Collectors are installed before navigation and separately assert zero console, page, and hydration errors. Every covered matrix view asserts serious/critical axe violations equal zero and horizontal overflow at most 1px.
- Tests assert semantic desktop tables/mobile cards/navigation, long-spec and price/inventory/status non-overlap, long-email containment/action alignment, customer price privacy, and the three customer status states.
- Screenshot data is local and deterministic; screenshots are full-page and unmasked. Session `updatedAt` is fixed for stable account “recent login” output, and catalog routes wait for network idle so local image responses finish before capture.

## Visual inspection and artifacts

- Inspected desktop/mobile pairs for admin catalog, admin accounts, and customer catalog. Hierarchy, wrapping, status clarity, and boundaries were clean; no production defect was returned to Tasks 4–6.
- The 15 exact matrix screenshots are under:
  `C:\Users\AKSSINA\.codex\worktrees\c215\kuajinng\tests\e2e\merchant-center-visual.spec.ts-snapshots`
- Filename patterns:
  - `admin-catalog-{viewport}-desktop-chromium-win32.png`
  - `admin-accounts-{viewport}-desktop-chromium-win32.png`
  - `customer-catalog-{viewport}-desktop-chromium-win32.png`
- Existing merchant-center baselines updated by the same bounded visual run reflect the already-landed Task 4–6 global navigation/catalog hierarchy and current field-aligned catalog rendering. The visible changes were reviewed with the new catalog/account matrix; no masks or unrelated production changes were introduced.
- The final Impeccable detector was intentionally not run; it remains deferred until inventory UI completion.

## Risks

- Playwright uses a local Next development server and a serial worker; first-route compilation dominates runtime but all final no-update runs are green.
- Asset rows are content-addressed and fixture inserts are idempotent; temporary on-disk artifacts must continue to be excluded/cleaned after E2E runs.
