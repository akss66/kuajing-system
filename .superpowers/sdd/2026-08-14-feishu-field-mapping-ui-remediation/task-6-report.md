# Task 6 implementation report

## Outcome

- Replaced the account CSS-grid pseudo-table with one native table named `账号列表`.
- Kept one table row renderer for every account. The same native rows become summary cards below `xl` and table rows at `xl` and above, so drawer triggers and permission behavior are not duplicated.
- Added one fixed eight-column `colgroup`, including a narrow `w-28` action column, and allowed email cells to wrap with `overflow-wrap:anywhere`.
- Limited tab-list horizontal overflow to widths below `xl`.
- Marked the current navigation group semantically and strengthened only its heading with existing semantic merchant tokens. Route matching, link order, local-storage key, default disclosure state, automatic opening, focus order, and leaf `aria-current="page"` remain unchanged.

## Witnessed RED → GREEN evidence

### RED

Command:

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx tests/unit/ui/merchant-shell.test.tsx
```

Exit code: `1`. Vitest reported `4 failed | 15 passed` across two files. The failures were functional and expected:

- the account surface was a `SECTION` instead of a native `TABLE`;
- no long-email table cell/fixed action column existed;
- the tab list had no `xl:overflow-x-visible` reset;
- the active navigation section had no current-group marker or heading treatment.

### GREEN and adjacent regression coverage

Command:

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx tests/unit/ui/merchant-shell.test.tsx tests/unit/ui/management-primitives.test.tsx
```

Exit code: `0`. Result: `3 passed` files, `26 passed` tests.

Command:

```powershell
npm.cmd run typecheck
```

Exit code: `0` (`tsc --noEmit`).

Command:

```powershell
git diff --check
```

Exit code: `0`; no whitespace errors. Git emitted only the repository's existing LF-to-CRLF working-copy notices.

## Skill and installed-guide influence

- Impeccable context/polish/craft-floor classified this as an **Operate** refinement: preserve the incumbent merchant-center world, use the existing flat surfaces and restrained teal semantic tokens, and avoid redesign, gradients, raw colors, local fonts, decorative motion, or nested cards.
- `frontend-ui-engineering` drove the native table semantics, controlled long-content wrapping, breakpoint-specific composition, intact keyboard order, visible text status, and reuse of the existing drawer/button/table primitives.
- Strict TDD plus `writing-good-tests` kept assertions on real rendered DOM behavior. Every added behavior was observed failing against the unchanged implementation before the minimum production change was written.
- Installed Next 16 server/client, CSS, Vitest/testing, and accessibility guidance kept the existing client boundary, used project Tailwind utilities instead of global CSS changes, and tested synchronous client components through role-based Testing Library queries.

## Boundaries and residual risk

- No menu label, order, route, local-storage key, permission/action/audit behavior, drawer content, catalog, inventory, migration, global typography/style, or production configuration changed.
- Unit tests prove DOM semantics and responsive utility contracts, but do not execute real media queries or measure page overflow. The approved plan assigns exact viewport, axe, console, hydration, and visual acceptance to Task 7.
- Per the Task 6 brief, the final Impeccable detector and Task 7 were intentionally not run or started.

## Fix Round 1: distinct responsive account surfaces

Review found that the first implementation visually restyled one native table row as a mobile card. The fix restores two explicit surfaces while sharing the account identity, email, role, customer, store-count, status, latest-login, and detail-trigger renderers:

- `[data-account-table]` is one native fixed-layout table with the exact eight headers and shared `colgroup`; it is `hidden` below `xl` and `xl:table` at desktop widths.
- Each `[data-account-card]` is a separate summary-list `LI`, visible below `xl` and `xl:hidden` at desktop widths.
- The existing drawer content and action/permission behavior remain unchanged. Navigation and tabs were not modified in this fix round.

### Fix Round 1 RED

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx
```

Exit code: `1`. Result: `2 failed | 12 passed`. The failures directly reproduced the review finding: the table lacked its mobile-hidden contract, and `[data-account-card]` resolved to a table `TR` instead of a separate `LI`.

### Fix Round 1 GREEN

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx
```

Exit code: `0`. Result: `1 passed` file, `14 passed` tests.

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx tests/unit/ui/merchant-shell.test.tsx tests/unit/ui/management-primitives.test.tsx
```

Exit code: `0`. Result: `3 passed` files, `27 passed` tests.

```powershell
npm.cmd run typecheck
```

Exit code: `0` (`tsc --noEmit`).

```powershell
git diff --check
```

Exit code: `0`; no whitespace errors.

### Browser acceptance attempt

The existing mobile Playwright test directly asserts that `[data-account-card]` is visible, `[data-account-table]` is not visible, and document horizontal overflow is at most 1px. It was invoked with:

```powershell
npm.cmd run test:e2e -- tests/e2e/admin-management.spec.ts --project=mobile-chromium --grep 'super admin can govern admin accounts and ordinary admins are denied account governance'
```

The Next 16 test server and `mobile-chromium` worker started successfully, but the test failed before navigation or selector evaluation while resetting the E2E database: PostgreSQL reported `relation "jifeng_authorization_attempts" does not exist`. No product assertion failed. The focused unit test directly covers both existing E2E selectors and their breakpoint visibility classes until the E2E schema baseline is available.
