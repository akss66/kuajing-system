# Task 3 report: privacy-separated catalog query models

Date: 2026-08-14

## Scope implemented

- Added the administrator-only `listAdminCatalog()` query model with source sequence, both internal price facts, total and available inventory, manual sale status, attributes, image, and link facts.
- Reworked `listCustomerCatalog(customerId)` to project only customer-safe DTO fields, resolve the active customer price with default-price fallback, include manual-unavailable rows, and expose independent `saleStatus`, `orderable`, and `availabilityReason` facts.
- Both query models subtract only ACTIVE reservations and clamp available inventory at zero.
- Adjusted the catalog asset Route Handler so an authenticated customer can read the image of an ACTIVE product's manual-unavailable SKU. The existing unauthenticated 401, inactive-product 404, admin path, safe headers, and storage error behavior remain intact.
- Preserved order price priority and added another-customer price isolation coverage. No global temporary-price concept was added.
- Preserved bulk-draft ownership isolation; only clarified the existing regression name.
- With controller authorization, updated two legacy Task 5 unit-test DTO fixtures to satisfy the new strict required contract, without changing assertions or component behavior.
- With controller authorization, updated the pre-existing asset-route regression whose old NOT_SELLABLE=404 expectation directly conflicted with this task's approved 200 contract.

No migrations, inventory modules/UI, Feishu modules/writers/outbox, fulfillment/Jifeng state machines, permission semantics, or production configuration were changed.

## Installed Next.js guidance read before Route Handler edits

- `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- `node_modules/next/dist/docs/01-app/02-guides/authentication.md` (authorization, DAL/DTO, and Route Handler sections)
- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`

Applied guidance: Route Handlers remain public API boundaries with server-side authentication/authorization; dynamic `params` remain awaited promises; customer DTOs explicitly return only needed fields.

## Witnessed RED

Command (exit 1):

```powershell
npm.cmd run test:integration -- tests/integration/catalog/catalog-queries.test.ts tests/integration/catalog/pricing.test.ts tests/integration/bulk-order/validation.test.ts
```

Evidence:

- Test files: 1 failed, 2 passed (3 total).
- Tests: 3 failed, 16 passed (19 total).
- Customer query returned only two SELLABLE rows; `availabilityReason` was `undefined`, and the NOT_SELLABLE row was absent.
- Dynamic import of `@/modules/catalog/admin-catalog` failed because the required module did not exist.
- An authenticated customer received 404 for a manual-unavailable SKU image; the same test's unauthenticated request correctly remained 401.

These were functional contract failures from the missing behavior, not fixture, syntax, or environment failures.

## Witnessed GREEN and adjacent verification

Focused catalog/pricing/bulk validation (exit 0):

```powershell
npm.cmd run test:integration -- tests/integration/catalog/catalog-queries.test.ts tests/integration/catalog/pricing.test.ts tests/integration/bulk-order/validation.test.ts
```

- Test files: 3 passed (3).
- Tests: 19 passed (19).

Existing asset Route Handler regression (exit 0):

```powershell
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
```

- Test files: 1 passed (1).
- Tests: 6 passed (6).

Order submission and identity access guards (exit 0):

```powershell
npm.cmd run test:integration -- tests/integration/orders/submission.test.ts tests/integration/identity/access-guards.test.ts
```

- Test files: 2 passed (2).
- Tests: 13 passed (13).

Strict DTO fixture compatibility (exit 0):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

- Test files: 1 passed (1).
- Tests: 4 passed (4).

Typecheck (exit 0):

```powershell
npm.cmd run typecheck
```

Diff whitespace check (exit 0):

```powershell
git diff --check
```

## Privacy, authorization, and mutation audit

- Runtime assertions prove every customer row omits `sourceSequence`, `totalQuantity`, `cargoUnitPriceMilliYuan`, and `defaultUnitPriceMilliYuan`.
- `CustomerCatalogItem` structurally declares no administrator-only field; all new customer-facing fields are required.
- The customer SQL selection names only resolved `actualUnitPrice*` and `availableQuantity` outputs. Customer price joining remains constrained by both `customerId` and `active=true`.
- Distinct SKU-name and specification literals prove `specification` is sourced from `skus.specification`.
- Availability precedence is manual NOT_SELLABLE, then sold out, then available.
- The asset handler still calls `getCurrentPrincipal()` before any asset query; unauthenticated access remains 401, inactive products remain 404, and the change does not create customer-specific asset entitlements that the global catalog did not previously have.
- No Feishu writer or outbox symbol was added or called. No write-enabled configuration changed.

## Review outcome and risks

Five-axis self-review found no unresolved correctness, security, architecture, readability, or performance blocker. The query models use one aggregate reservation subquery and one catalog query each, avoiding N+1 reads.

Residual risks:

- Catalog list queries are intentionally unpaginated because the approved Task 3 interface returns the complete catalog; a future catalog size substantially beyond the current 140 SKU rows may require pagination.
- Catalog assets remain globally visible to any authenticated customer when their product is ACTIVE, matching the existing shared-catalog model. This task does not introduce a per-customer catalog entitlement model.
- Full-suite integration, lint, build, and E2E verification are branch-final gates in the approved plan and were not run as Task 3-specific evidence.
