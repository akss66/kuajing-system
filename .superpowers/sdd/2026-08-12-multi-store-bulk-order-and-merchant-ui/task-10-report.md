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
