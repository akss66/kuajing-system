# Task 5 report: accurate and private customer catalog

Date: 2026-08-14

## Scope implemented

- Kept the route page as an async Server Component and passed Task 3 `CustomerCatalogItem[]` directly into the customer workspace.
- Restricted server-side search to customer-safe fields only: SKU code, product name, true specification, and safe link text. Removed `skuName` from search and did not add any administrator-only fact.
- Rebuilt the wide customer view as a semantic table named `客户货盘列表` with the task-focused columns `商品`, `规格/属性`, `实际拿货价`, `可售库存`, `状态`, and `链接`.
- Kept the table hidden below `xl`; narrow layouts use a named list of cards ordered exactly as identity, specification/attributes, actual customer price, available inventory, status, and link.
- Rendered `specification` as the primary specification. Color, combination sales, and gram weight appear only as labeled secondary attributes; `skuName` is not rendered as specification.
- Mapped availability reasons to the exact copy `可售`, `不可售`, and `售罄`. Manual-unavailable and sold-out rows remain visible, retain their actual available inventory, and expose `aria-disabled="true"` rather than presenting an ordering action.
- Rendered only the resolved customer price and available inventory. Customer markup contains no source sequence, procurement-price label, total inventory, or cargo-price label.
- Added a fail-closed URL guard at the customer rendering boundary. Only absolute HTTP(S) product URLs become links; unsafe values render `链接不可用`, missing values render `暂无链接`, and valid new-tab links include `noopener noreferrer`.
- Reserved 48×48 image geometry, added useful real/missing image accessible names, clamped long specifications to two wrapping lines, retained tabular figures, and kept customer touch targets at least 44px.

No query model, administrator UI, migration, inventory, Feishu, fulfillment/order semantics, global style/font, or production configuration file was changed.

## Required guidance read before implementation

- Approved design: `docs/superpowers/specs/2026-08-14-feishu-field-aligned-ui-design.md`
- Complete 827-line implementation plan: `docs/superpowers/plans/2026-08-14-feishu-field-mapping-ui-remediation.md`
- Task brief: `.superpowers/sdd/2026-08-14-feishu-field-mapping-ui-remediation/task-5-brief.md`
- Impeccable: `SKILL.md`, one project context run, `reference/polish.md`, and `reference/craft-floor.md`
- Frontend UI Engineering: `SKILL.md`. Its linked `accessibility-checklist.md` is absent at the declared relative path, so its in-file accessibility requirements and the approved WCAG 2.2 AA specification governed this task.
- Strict TDD: `SKILL.md` and `writing-good-tests.md`
- Execution/verification discipline: executing-plans, verification-before-completion, incremental-implementation, and git-workflow-and-versioning skills
- Installed Next.js 16 App Router guidance: layouts/pages and `page.tsx`, Server/Client Components, data fetching, CSS, image optimization, and Vitest under `node_modules/next/dist/docs/01-app/`

Applied Next.js guidance: the route retains server-only identity and database reads; the interactive form/workspace stays inside the existing Client Component boundary; the customer DTO is serializable; protected image URLs use `next/image` with explicit intrinsic dimensions and `unoptimized`; and no page-local CSS or font boundary was introduced.

## Witnessed RED

Command (exit 1):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

Qualifying RED after adding only customer behavior assertions:

- Test files: 1 failed (1).
- Tests: 6 failed, 11 passed (17 total).
- The old presentation emitted only one standalone `可售` label and did not distinguish sold-out from manual unavailable.
- Customer cards had no required accessible name or ordered section structure.
- Four unsafe customer product URL cases had no fail-closed `链接不可用` state.
- Image accessible names still included `skuName`, matching the old false-specification presentation.

All failures represented missing customer presentation behavior, not syntax, fixture, environment, or module-resolution errors.

## Witnessed GREEN and regression evidence

Focused unit GREEN (exit 0):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

- Test files: 1 passed (1).
- Tests: 17 passed (17).

Bulk-order and order-submission boundary regression (exit 0):

```powershell
npm.cmd run test:integration -- tests/integration/bulk-order/validation.test.ts tests/integration/orders/submission.test.ts
```

- Test files: 2 passed (2).
- Tests: 13 passed (13).
- Existing order validation continues rejecting non-orderable inventory; no ordering or fulfillment state-machine code changed.

Typecheck (exit 0):

```powershell
npm.cmd run typecheck
```

Diff whitespace check (exit 0):

```powershell
git diff --check
```

## Privacy, accessibility, responsive, and polish audit

- The customer table/card source scan contains no `sourceSequence`, `totalQuantity`, `cargoUnitPrice`, `skuName`, or internal labels `采购价`, `总库存`, and `货品价格`.
- The table is a native semantic table and the narrow view is a semantic named list. Both representations expose the same safe facts.
- Long product/specification/link/attribute content uses `min-w-0`, controlled wrapping/clamping, or truncation at the correct level. The table has no minimum width and is not rendered below `xl`, so this task adds no page-level horizontal scrolling.
- Product links remain native keyboard-focusable anchors with visible text, safe target relationship attributes, and a consistent Lucide external-link icon.
- Status is conveyed through exact text in addition to semantic token colors. Unavailable records remain visible and expose a disabled state; the unchanged integration boundary remains authoritative for ordering.
- The source uses only project semantic tokens and global typography. No raw colors, gradients, local `font-family`, decorative motion, nested cards, or new global styles were added.

Impeccable influenced the result by preserving the incumbent flat merchant-center world, treating this as a narrow refinement, sharing table/card fact renderers, prioritizing real long/missing/disabled states, and keeping interactive targets at the customer portal's 44px floor. Frontend UI Engineering influenced the native semantics, visible status text, stable image geometry, responsive composition, and source-safe Server/Client boundary. Per the Task 5 brief, the final Impeccable detector was not run.

## Risks and deferred acceptance

- Real-browser overflow, axe, zoom, console/hydration, keyboard-path, and unmasked screenshot verification across the exact viewport matrix belong to Task 7 and were not run in this component task.
- The shared `Table` primitive still owns an overflow container globally; this customer table uses fixed 100% geometry with no minimum width and is hidden below `xl`, but Task 7 remains the browser-level proof.
- This task does not add an ordering control to the catalog. Non-orderability is communicated through exact status text and `aria-disabled`; the existing order submission and bulk-order validation remain the enforcement boundary.
