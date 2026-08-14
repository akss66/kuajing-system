# Task 4 report: administrator product and SKU workspace

Date: 2026-08-14

## Scope implemented

- Replaced the page-local SKU projection with Task 3 `listAdminCatalog()` while retaining the existing customer/store reads and mutation actions.
- Made `CatalogWorkspace.rows` the strict `AdminCatalogItem[]` contract (exported through the existing `CatalogRow` alias for unchanged mutation-drawer compatibility).
- Added client filtering over source sequence, product name, real specification, and SKU code.
- Rebuilt the administrator results as a semantic table named `商品与 SKU 列表` with exactly nine information columns: `序号`, `商品`, `规格/属性`, `采购价`, `总库存`, `可售库存`, `货品价格`, `状态`, and `链接`.
- Kept the table fixed-width and visible only from `xl`; below `xl`, a semantic list of cards presents identity, specification/attributes, both prices, inventory, status, then link in that fixed order.
- Shared the product-identity, attribute, status, price, and external-link renderers between table and cards. Product images reserve explicit 48×48 dimensions; missing images expose an accessible `图片缺失` name.
- Kept procurement and cargo prices independent and formatted through the integer milli-yuan formatter, including exact `¥0.325` and `¥1.366` values.
- Long specifications are limited to two wrapping lines with word breaking, while numeric columns use right alignment and tabular figures.
- Product links preserve supplied link text, open safely in a new tab, and include `noopener noreferrer`.

No customer UI, query model, migration, inventory, Feishu, fulfillment, global style/font, or production configuration file was changed.

## Required guidance read before implementation

- Approved design: `docs/superpowers/specs/2026-08-14-feishu-field-aligned-ui-design.md`
- Full implementation plan: `docs/superpowers/plans/2026-08-14-feishu-field-mapping-ui-remediation.md`
- Task brief: `.superpowers/sdd/2026-08-14-feishu-field-mapping-ui-remediation/task-4-brief.md`
- Impeccable: `SKILL.md`, project context output, `reference/polish.md`, and `reference/craft-floor.md`
- Frontend UI Engineering: `SKILL.md`; its directly linked `../../references/accessibility-checklist.md` was absent at the declared path and was not found elsewhere under `.codex`, so the skill's in-file WCAG guidance and the approved WCAG 2.2 AA spec governed the implementation.
- Installed Next.js 16 App Router guidance: server/client components, data fetching, CSS, images, Vitest, Image API, and the `page.tsx` convention under `node_modules/next/dist/docs/01-app/`.

Applied Next.js guidance: the route page remains an async Server Component and performs the ORM-backed reads; only the interactive search workspace remains a Client Component; the strict catalog DTO passed across the boundary is serializable; authenticated asset URLs use `next/image` with explicit intrinsic dimensions and `unoptimized`; no page-local CSS or font boundary was introduced.

## Witnessed RED

Command (exit 1):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

The first attempt exposed an old-contract fixture runtime error and was not accepted as RED. After changing only the test fixture to permit the old component to render, the qualifying run produced:

- Test files: 1 failed (1).
- Tests: 3 failed, 5 passed (8 total).
- The desktop table exposed the old five headers rather than the required nine.
- A source-sequence-only query returned no table.
- A real-specification-only query returned no table.

All qualifying failures were functional missing-behavior failures, not syntax, fixture, or environment failures. The temporary legacy fixture compatibility fields were removed after GREEN so the final tests mirror the strict Task 3 DTO exactly.

## Witnessed GREEN and adjacent verification

Focused component test after implementation and post-GREEN fixture cleanup (exit 0):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

- Test files: 1 passed (1).
- Tests: 8 passed (8).

Focused plus adjacent management primitives (exit 0):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx tests/unit/ui/management-primitives.test.tsx
```

- Test files: 2 passed (2).
- Tests: 15 passed (15).

Typecheck (exit 0):

```powershell
npm.cmd run typecheck
```

Diff whitespace check (exit 0):

```powershell
git diff --check
```

## Accessibility, responsive, typography, and polish audit

- Native table/head/body/row/cell semantics and an explicit accessible table name are preserved; the narrow presentation is a named list of list items rather than a compressed table.
- Both real and missing images have useful accessible names; real images reserve intrinsic dimensions to prevent layout shift.
- External links retain visible supplied text, keyboard-native anchor behavior, a visible global focus style, a consistent Lucide external-link icon, and safe new-tab relationship attributes.
- Long product/specification/link/attribute content has `min-w-0`, controlled wrapping/clamping, or truncation at the appropriate hierarchy; no fixed table minimum width or page-level horizontal scrolling was added.
- Numeric sequence, money, and inventory facts are right-aligned and use the global tabular-number utility.
- Source scan found no page/business-component `font-family`, page font utility, raw color, decorative gradient, or `overflow-x` rule. Global Geist Variable + Noto Sans SC Variable remain untouched.
- Table/cards share the same fact renderers, reducing parity drift. Missing cargo price, missing source sequence, missing specification, missing link, and missing image states remain explicit.

Impeccable influenced the result by preserving the incumbent flat merchant-center world, prioritizing scanability and real missing/long-content states, avoiding nested cards/decorative effects, and keeping the refinement bounded to the approved administrator path. Per the controller and Task 4 brief, the one-time Impeccable detector was not run; it remains a branch-final gate after all UI tasks.

## Risks and deferred acceptance

- Browser-level overflow, zoom, axe, console/hydration, and screenshot verification across the exact viewport matrix belong to Task 7 and were not run in this component-only task.
- The shared `Table` primitive retains its local overflow container for all application tables. This Task 4 table has no minimum width, uses fixed 100% column geometry, and is hidden below `xl`, so it does not introduce page-level horizontal overflow; real-browser acceptance remains the Task 7 proof.
- The catalog remains intentionally unpaginated because Task 3 returns the complete administrator catalog and the current acceptance set is 140 SKUs.

## Fix round 1: restrict rendered external-link protocols

Independent review identified that the shared product-link renderer inserted the database `productUrl` directly into `href`. React rewrote a `javascript:` URL to its blocked sentinel but still emitted an anchor; FTP and relative values remained clickable. The rendering boundary now parses the value with one pure guard and permits only absolute `http:` or `https:` URLs. Invalid values render the explicit non-interactive text `链接不可用` in both the table and cards. Valid HTTP(S) URL rendering, supplied link text, safe new-tab attributes, and the distinct missing-value state `暂无链接` remain unchanged.

Witnessed RED (exit 1):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

- Test files: 1 failed (1).
- Tests: 3 failed, 8 passed (11 total).
- `javascript:`, `ftp:`, and relative URLs each still rendered an anchor instead of `链接不可用`.

Focused GREEN (exit 0):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

- Test files: 1 passed (1).
- Tests: 11 passed (11).

## Fix round 2: malformed URL characterization coverage

The unsafe-link parameterized test now also supplies `not a url` and the structurally invalid `https://`. Both values exercise the URL parser's exception path and prove that the rendering boundary fails closed: neither table nor card emits an anchor, and both display `链接不可用`. This is characterization coverage of the Fix Round 1 guard; no production code changed.

Focused verification (exit 0):

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

- Test files: 1 passed (1).
- Tests: 13 passed (13).
