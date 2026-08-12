## Task 10 Report

Date: 2026-08-12

Implemented:
- Added account-governance database rules in `drizzle/0014_account_governance.sql` and `src/db/schema/auth.ts`:
  - `auth_users.role` is constrained to `super_admin | admin | user`
  - admin roles must keep `customer_id` null
  - customer users must keep `customer_id` non-null
  - only `customer_id` has a database unique partial index
  - no database unique index or constraint was added for `role = 'super_admin'`
  - migration `0014` now only upgrades the known bootstrap identity (`00000000-0000-4000-8000-00000000a001` / `admin@tongzhouxing.local`) to `super_admin`
  - migration `0014` now fails early with actionable diagnostics for duplicate `customer_id`, unsupported legacy roles, and `user` rows missing `customer_id`
  - migration `0014` now disambiguates bootstrap markers before promotion: the fixed bootstrap id and email may match zero or one row total, but if they resolve to different rows the migration fails fast instead of widening promotion
- Updated Better Auth and identity guards so:
  - Better Auth admin plugin only treats `super_admin` as an account-governance administrator
  - `requireAdmin()` accepts `ADMIN` and `SUPER_ADMIN`
  - `requireSuperAdmin()` only accepts `SUPER_ADMIN`
  - current principal resolution distinguishes `SUPER_ADMIN` from ordinary `ADMIN`
- Added account governance services, queries, and actions in `src/modules/accounts/`:
  - only `SUPER_ADMIN` can create admins, update managed accounts, reset passwords, or disable/restore accounts
  - service/API paths reject creating or promoting any additional `super_admin`
  - the bootstrapped `super_admin` is immutable for role/status changes
  - disabling a managed account revokes active sessions instead of deleting the account
- Completed customer/store backend management in `src/modules/customers/`:
  - customer disable performs a soft-disable, updates mirrors, and revokes active sessions
  - store disable remains a soft-disable and only blocks new order/import flows
  - customer/store updates and status changes write before/after/reason audit rows
  - added missing customer/store management server actions and cache revalidation wiring
  - customer account provisioning now requires an operator-supplied `reason` and persists it into the creation audit record instead of using a fixed message
- Fixed bootstrap/seed behavior in `src/db/seed.ts`:
  - seed still creates exactly one protected `super_admin`
  - seed now also creates matching `admin_users` and `customer_users` mirror profiles so the initialized accounts are operational in downstream admin/customer flows

Tests added/updated:
- `tests/integration/accounts/governance.test.ts`
- `tests/integration/customers/provisioning.test.ts`
- `tests/integration/identity/access-guards.test.ts`
- `tests/integration/schema/account-governance-migration.test.ts`
- `tests/unit/customers/customer-management-actions.test.ts`

Verification:
- `npm.cmd run test:integration -- tests/integration/schema/account-governance-migration.test.ts`
- `npm.cmd run test:integration -- tests/integration/accounts/governance.test.ts tests/integration/customers/provisioning.test.ts tests/integration/identity/access-guards.test.ts tests/integration/schema/identity-customers.test.ts`
- `npm.cmd run test:integration -- tests/integration/bulk-order/draft.test.ts tests/integration/order-import/preview.test.ts`
- `npm.cmd run test -- tests/unit/customers/customer-management-actions.test.ts`
- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `git diff --check`

Notes:
- The integration suites share `tongzhouxing_test`. Running multiple Vitest integration commands in parallel produces false negatives from cross-process DB interference. Final verification was run serially.
- Account/session disable paths were verified for the normal path and the recovery path (`DISABLED` -> session revocation, `ACTIVE` -> status restore without physical deletes).

UI Phase B:
- Added `src/app/(admin)/admin/accounts/page.tsx` for super-admin-only account governance UI:
  - segregated admin/customer account views
  - protected bootstrap super admin row with no reset/disable controls
  - create normal admin only, plus update/reset/disable/restore flows
  - account listing now shows latest login, customer ownership, store coverage, and status
- Updated `src/app/(admin)/admin/layout.tsx`, `src/components/layout/admin-shell.tsx`, and `src/components/layout/logout-button.tsx`:
  - ordinary admins can still enter the admin shell for daily customer/store work
  - only super admins see the `账号管理` navigation entry
  - direct visits to `/admin/accounts` from ordinary admins render a safe denial state
  - added a discoverable logout button in the shell header
- Expanded customer management UI:
  - `src/app/(admin)/admin/customers/page.tsx` now shows account status, store count, and a detail entry
  - `src/app/(admin)/admin/customers/[customerId]/page.tsx` now supports customer profile edits, unique account summary, add/edit/disable/restore for multiple stores
- Updated login/admin/customer server actions for real success states and cache refresh:
  - `src/modules/accounts/actions.ts`
  - `src/modules/customers/actions.ts`
  - success responses are now operator-facing Chinese copy and account/customer pages revalidate after writes
- Updated login surface copy in `src/app/(auth)/login/page.tsx` to remove `履约` wording and keep the approved information architecture.

UI tests added/updated:
- `tests/unit/accounts/account-management.test.tsx`
- `tests/unit/customers/customer-management-pages.test.tsx`
- `tests/unit/customers/customer-management-actions.test.tsx`
- `tests/e2e/admin-management.spec.ts`

UI verification:
- `npm.cmd test -- tests/unit/accounts/account-management.test.tsx`
- `npm.cmd test -- tests/unit/customers/customer-management-pages.test.tsx`
- `npm.cmd run test:e2e -- tests/e2e/admin-management.spec.ts --project=desktop-chromium`
- `npm.cmd run test:e2e -- tests/e2e/admin-management.spec.ts --project=mobile-chromium`
- `npm.cmd test`
- `npm.cmd run test:integration -- --maxWorkers 1 tests/integration/accounts/governance.test.ts tests/integration/customers/provisioning.test.ts`
- `npm.cmd run typecheck`
- `npm.cmd run lint`
- `git diff --check`
- `node C:\Users\AKSSINA\Desktop\kuajinng\.agents\skills\impeccable\scripts\detect.mjs --json "src/app/(admin)/admin/accounts/page.tsx" "src/app/(admin)/admin/customers/page.tsx" "src/app/(admin)/admin/customers/[customerId]/page.tsx" "src/app/(auth)/login/page.tsx" "src/components/layout/admin-shell.tsx" "src/components/layout/logout-button.tsx"`

Visual evidence:
- Screenshots saved to `.superpowers/sdd/2026-08-12-multi-store-bulk-order-and-merchant-ui/task-10-visual/`
  - `accounts-1440.png`
  - `accounts-390.png`
  - `customer-detail-1440.png`
  - `customer-detail-390.png`
- Console capture saved beside the screenshots:
  - `console-1440.json`
  - `console-390.json`

UI concerns:
- `console-1440.json` captures repeatable React hydration warnings on form-heavy pages. The diff is consistently a browser-side `style="caret-color: transparent"` attribute appearing on inputs/hidden inputs before hydration. Mobile capture (`console-390.json`) is clean. No page-level runtime exceptions or horizontal overflow were observed in either viewport.
