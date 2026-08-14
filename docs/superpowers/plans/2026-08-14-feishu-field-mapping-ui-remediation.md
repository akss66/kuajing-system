# Feishu Field Mapping and UI Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the current Feishu cargo field structure in PostgreSQL and remediate the admin catalog, customer catalog, account management, and navigation UI without changing fulfillment, settlement, tenancy, inventory, or authorization semantics.

**Architecture:** Extend the product aggregate with nullable Feishu-owned metadata (`sourceSequence`, `linkText`, and `cargoUnitPriceMilliYuan`), then make the existing read-only preflight confirmation reconcile current Feishu-owned catalog metadata idempotently by SKU code and source sequence. Keep inventory balances authoritative in PostgreSQL for existing SKUs, initialize inventory only for genuinely new SKUs, remove the migration-to-target-write handoff, and expose separate admin and customer read models so internal cost/stock facts cannot leak into the portal. Preserve the incumbent merchant-center visual system while switching dense desktop views to semantic tables and narrow layouts to task-ordered cards.

**Tech Stack:** Next.js 16.3 App Router, React 19.2, TypeScript 6, Drizzle ORM 0.45, PostgreSQL, Tailwind CSS 4, Vitest, Testing Library, Playwright, axe-core.

## Global Constraints

- The Feishu source Wiki and business spreadsheet are permanently read-only: never write cells, rows, formatting, worksheets, permissions, or images to the source.
- `FEISHU_CARGO_WRITES_ENABLED` remains `false` in production, local E2E, and every remediation flow; confirmation must not enqueue or call any Feishu target writer.
- This work may read Feishu into PostgreSQL and modify this application's UI only; it must not deploy or alter external systems.
- Do not change Jifeng authorization/fulfillment state machines, order settlement, inventory reservation/deduction, customer isolation, permission, audit, or dangerous-action semantics.
- `cargoUnitPriceMilliYuan` is independent from SKU `defaultUnitPriceMilliYuan`; both use non-negative integer milli-yuan values and must never be collapsed.
- `sourceSequence` is the long-lived Feishu sequence value. There are exactly 74 source-sequence groups and 140 SKU rows in the field-aligned acceptance fixture; one sequence may own multiple SKUs, including `TZX-034-1`, `TZX-034-2`, and `TZX-034-3`.
- One SKU has at most one current image. Missing images preserve the SKU and business fields and render an explicit placeholder.
- Existing SKU inventory balances remain authoritative and are not overwritten by metadata backfill. A newly created SKU receives its initial balance and inventory movement from its Feishu row exactly once.
- Manual sale status and order availability are separate facts. `SELLABLE` with zero available inventory is sold out; `NOT_SELLABLE` remains visible to customers but is not orderable.
- The general customer catalog has no order-specific temporary-price context. It resolves active customer-specific price then default price; existing order submission continues to resolve temporary override, active customer price, then default price.
- Customer UI never exposes source sequence, total inventory, default procurement-cost wording, or cargo unit price; it shows actual customer price and available inventory only.
- Global typography remains locally bundled `Geist Variable` + `Noto Sans SC Variable`; pages and business components must not set their own `font-family`.
- Acceptance sizes are 1440×900, 1920×1080, 430×900, 390×844, and 360×800. No page-level horizontal overflow is allowed; mobile catalog and account tasks cannot depend on horizontal scrolling.
- WCAG 2.2 AA is the target; axe serious/critical findings, console errors, page errors, and hydration errors must be zero on covered routes.
- Every behavior change follows a witnessed RED → minimal GREEN cycle. Every task ends in an atomic commit, independent spec review, independent code-quality review, and fix/re-review loop before the next task.

## File Structure

- `src/db/schema/catalog.ts` owns the three product metadata columns and database checks.
- `drizzle/0020_feishu_field_mapping.sql` plus Drizzle snapshot/journal files own the forward-only schema migration.
- `src/modules/feishu/cargo-types.ts` and `cargo-parser.ts` own the source-sequence/cargo-price normalized contract and inventory-independent manual status.
- `src/modules/feishu/migration-service.ts` owns idempotent PostgreSQL reconciliation and must not enqueue target writes.
- `src/modules/catalog/admin-catalog.ts` owns the admin-only query model, including total and available inventory.
- `src/modules/catalog/customer-catalog.ts` owns the customer-safe query model and orderability reason.
- `src/components/catalog/*` own separate admin and customer presentations; neither reads the database.
- `src/components/accounts/account-management-workspace.tsx` owns the semantic account table and mobile summary cards.
- `src/components/layout/navigation-section.tsx` owns active-group hierarchy without changing routes or order.
- Focused unit/integration tests prove behavior; Playwright specs own responsive, accessibility, overflow, console, hydration, and visual evidence.

---

### Task 1: Persist and parse the field-aligned Feishu contract

**Files:**
- Modify: `src/db/schema/catalog.ts`
- Create: `drizzle/0020_feishu_field_mapping.sql`
- Create: `drizzle/meta/0019_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/modules/feishu/cargo-types.ts`
- Modify: `src/modules/feishu/cargo-parser.ts`
- Create: `tests/fixtures/feishu/field-aligned-cargo-source.ts`
- Modify: `tests/unit/feishu/cargo-parser.test.ts`
- Create: `tests/integration/schema/feishu-field-mapping.test.ts`

**Interfaces:**
- Produces `products.sourceSequence: string | null`, `products.linkText: string | null`, and `products.cargoUnitPriceMilliYuan: number | null`.
- Produces `NormalizedCargoRow.sourceSequence: string` and `NormalizedCargoRow.cargoUnitPriceMilliYuan: number`.
- Produces `MigrationSummary.sourceSequenceCount: number` while retaining `productCount` for existing consumers; both are 74 for the field-aligned fixture.
- Produces `buildFieldAlignedCargoSourceFixture(): { value: unknown[][] }` with 74 source sequences, 140 unique SKU codes, and 140 unique image tokens.

- [ ] **Step 1: Write schema and parser tests that name the regressions**

Add a real PostgreSQL test which inserts independent prices and proves the check constraint:

```ts
const [product] = await db.insert(products).values({
  cargoUnitPriceMilliYuan: 1366,
  linkText: "查看飞书商品",
  name: "字段映射商品",
  sourceSequence: "34",
}).returning();

expect(product).toMatchObject({
  cargoUnitPriceMilliYuan: 1366,
  linkText: "查看飞书商品",
  sourceSequence: "34",
});
await expect(
  db.insert(products).values({
    cargoUnitPriceMilliYuan: -1,
    name: "非法货品价格",
    sourceSequence: "negative-price",
  }),
).rejects.toThrow();
```

Add parser assertions derived from literal source values:

```ts
const parsed = parseLegacyCargoSheet(buildFieldAlignedCargoSourceFixture().value);
expect(parsed.summary).toMatchObject({ skuCount: 140, sourceSequenceCount: 74 });
expect(new Set(parsed.rows.map((row) => row.skuCode)).size).toBe(140);
expect(parsed.rows.filter((row) => row.sourceSequence === "34").map((row) => row.skuCode)).toEqual([
  "TZX-034-1",
  "TZX-034-2",
  "TZX-034-3",
]);
expect(parsed.rows.find((row) => row.skuCode === "TZX-034-1")).toMatchObject({
  cargoUnitPriceMilliYuan: 1366,
  defaultUnitPriceMilliYuan: 325,
  saleStatus: "SELLABLE",
  totalQuantity: 0,
});
```

The last assertion catches the production mutation that derives manual status from zero inventory.

- [ ] **Step 2: Run focused tests and witness RED**

Run:

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts
npm.cmd run test:integration -- tests/integration/schema/feishu-field-mapping.test.ts
```

Expected: unit compilation/assertion failure for the missing source-sequence/cargo-price fields and old zero-stock status coercion; integration failure for missing product columns.

- [ ] **Step 3: Add the minimal schema, migration, normalized types, and strict parser mapping**

Add nullable product columns for non-Feishu/manual products and checks/indexes:

```ts
sourceSequence: varchar("source_sequence", { length: 64 }),
linkText: varchar("link_text", { length: 500 }),
cargoUnitPriceMilliYuan: integer("cargo_unit_price_milli_yuan"),
```

The table callback adds a partial unique index on non-null `source_sequence` and `products_cargo_unit_price_milli_yuan_non_negative`. The SQL migration is forward-only and does not infer sequence or price values from SKU strings; the read-only backfill in Task 2 supplies authoritative values.

Parse the exact header `货品价格`, inherit it within the same source-sequence group, reject missing/malformed values as blocking, and preserve `parsedSaleStatus` regardless of quantity:

```ts
rows.push({
  cargoUnitPriceMilliYuan,
  saleStatus: parsedSaleStatus,
  sourceSequence,
  totalQuantity: quantity,
  // existing normalized fields remain unchanged
});
```

- [ ] **Step 4: Run focused tests and regression tests to witness GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts tests/unit/catalog/unit-price.test.ts
npm.cmd run test:integration -- tests/integration/schema/feishu-field-mapping.test.ts tests/integration/schema/exact-price-migration.test.ts
```

Expected: all named files pass with no warnings or unhandled errors.

- [ ] **Step 5: Inspect and commit the atomic change**

Run `git diff --check`, inspect `git diff -- src/db/schema/catalog.ts src/modules/feishu drizzle tests`, then commit:

```powershell
git add src/db/schema/catalog.ts src/modules/feishu/cargo-types.ts src/modules/feishu/cargo-parser.ts drizzle tests/fixtures/feishu/field-aligned-cargo-source.ts tests/unit/feishu/cargo-parser.test.ts tests/integration/schema/feishu-field-mapping.test.ts
git commit -m "feat: persist Feishu field mapping"
```

### Task 2: Reconcile existing SKUs through a read-only, idempotent database backfill

**Files:**
- Modify: `src/modules/feishu/migration-service.ts`
- Modify: `src/modules/feishu/queries.ts`
- Modify: `src/modules/feishu/actions.ts`
- Modify: `src/components/feishu/cargo-migration-panel.tsx`
- Modify: `playwright.config.ts`
- Modify: `tests/unit/config/playwright-config-database.test.ts`
- Modify: `tests/unit/feishu/actions.test.ts`
- Modify: `tests/unit/feishu/cargo-migration-panel.test.tsx`
- Modify: `tests/integration/feishu/migration-service.test.ts`
- Modify: `tests/integration/feishu/source-protection.test.ts`
- Modify: `docs/operations/feishu-cargo-migration.md`

**Interfaces:**
- Keeps `createFeishuCargoMigrationService(...).confirmCargoMigration(...)` as the public confirmation entry point.
- Confirmation upserts product metadata by `sourceSequence`, upserts/reparents SKU metadata by `skuCode`, reuses content-addressed assets, and returns the existing `MigrationSummary` shape plus `sourceSequenceCount`.
- Re-confirming the same imported run is a no-op success; it does not create products, SKUs, balances, movements, assets, audit events, or outbox events.
- Existing SKU inventory balances are never overwritten. Only a missing SKU receives one new balance and one opening inventory movement.
- Confirmation does not call `enqueueCargoSyncEvent` and every Playwright server receives `FEISHU_CARGO_WRITES_ENABLED: "false"`.

- [ ] **Step 1: Add RED integration tests for the 74/140 backfill and permanent read-only gate**

Seed an existing 140-SKU catalog whose products lack the new metadata, retain one active reservation and one customer price, then assert:

```ts
const first = await service.confirmCargoMigration({ actor, runId });
const second = await service.confirmCargoMigration({ actor, runId });

expect(first.summary).toMatchObject({ skuCount: 140, sourceSequenceCount: 74 });
expect(second).toEqual(first);
expect(await countDistinctSourceSequences()).toBe(74);
expect(await countSkus()).toBe(140);
expect(await countSkuImages()).toBe(140);
expect(await loadBalance(existingSkuId)).toEqual(balanceBeforeBackfill);
expect(await loadActiveReservation(existingSkuId)).toEqual(reservationBeforeBackfill);
expect(await loadCustomerPrice(existingSkuId)).toEqual(customerPriceBeforeBackfill);
expect(fakeTargetWriter.calls).toHaveLength(0);
expect(await countCargoOutboxEvents()).toBe(0);
```

Also assert source read/preflight failure and a missing required field leave all catalog tables unchanged.

- [ ] **Step 2: Run focused tests and witness RED**

Run:

```powershell
npm.cmd run test:integration -- tests/integration/feishu/migration-service.test.ts tests/integration/feishu/source-protection.test.ts
npm.cmd test -- tests/unit/config/playwright-config-database.test.ts tests/unit/feishu/actions.test.ts tests/unit/feishu/cargo-migration-panel.test.tsx
```

Expected: current confirmation rejects a non-empty catalog, enqueues a target sync, and Playwright forces writes enabled.

- [ ] **Step 3: Implement minimal reconciliation without changing operational state machines**

Inside the existing advisory-lock transaction:

```ts
// Pseudocode names the required behavior; use existing Drizzle transaction helpers.
for (const group of groupRowsBySourceSequence(rows)) {
  const productId = await upsertFeishuProductMetadata(tx, group);
  for (const row of group.rows) {
    const existingSku = await findSkuByCode(tx, row.skuCode);
    await upsertSkuMetadataAndImage(tx, productId, row, assetsBySku);
    if (!existingSku) await createOpeningInventoryExactlyOnce(tx, row);
  }
}
```

Do not update balances for existing SKUs, do not mutate customer prices/order rows/reservations, and do not delete unrelated or orphaned records. Remove confirmation's `enqueueCargoSyncEvent` call. Keep target-writer implementation isolated for historical compatibility, but expose no enabled remediation path while the write gate is false.

Update the integration panel copy to “只读预检 / 写入本系统数据库”; disabled target-write controls must not appear as a next step. Update the operations runbook to state 74 sequences/140 SKUs and the metadata-only rule for existing inventory.

- [ ] **Step 4: Run focused tests and the source protection regression to witness GREEN**

Run the Step 2 commands again, then:

```powershell
npm.cmd run test:integration -- tests/integration/feishu/outbox.test.ts tests/integration/inventory/concurrency.test.ts
```

Expected: reconciliation tests pass, source-protection passes, existing outbox isolation tests remain green, and no test server enables remote cargo writes.

- [ ] **Step 5: Inspect and commit the atomic change**

Run `git diff --check`, inspect the staged diff for `FEISHU_CARGO_WRITES_ENABLED: "true"`, then commit:

```powershell
git add src/modules/feishu src/components/feishu playwright.config.ts tests/unit/config tests/unit/feishu tests/integration/feishu docs/operations/feishu-cargo-migration.md
git commit -m "feat: backfill Feishu catalog metadata read-only"
```

### Task 3: Create privacy-separated admin and customer catalog query models

**Files:**
- Create: `src/modules/catalog/admin-catalog.ts`
- Modify: `src/modules/catalog/customer-catalog.ts`
- Modify: `src/app/api/catalog-assets/[assetId]/route.ts`
- Create: `tests/integration/catalog/catalog-queries.test.ts`
- Modify: `tests/integration/catalog/pricing.test.ts`
- Modify: `tests/integration/bulk-order/validation.test.ts`

**Interfaces:**
- Produces `listAdminCatalog(): Promise<AdminCatalogItem[]>`.
- `AdminCatalogItem` contains `id`, `sourceSequence`, `skuCode`, `imageUrl`, `productName`, `specification`, `color`, `combination`, `weightGrams`, `defaultUnitPriceMilliYuan`, `totalQuantity`, `availableQuantity`, `cargoUnitPriceMilliYuan`, `saleStatus`, `linkText`, and `productUrl`.
- Extends `CustomerCatalogItem` with `color`, `combination`, `weightGrams`, `linkText`, `productUrl`, `saleStatus`, `orderable`, and `availabilityReason: "AVAILABLE" | "MANUALLY_UNAVAILABLE" | "SOLD_OUT"`.
- Customer rows contain actual customer price and available inventory only; their type and query contain no source sequence, total inventory, or cargo price.

- [ ] **Step 1: Write RED integration tests for query accuracy, privacy, and independent status**

Create one SKU for each availability case and assert:

```ts
expect(adminRows.find((row) => row.skuCode === "TZX-034-1")).toMatchObject({
  availableQuantity: 7,
  cargoUnitPriceMilliYuan: 1366,
  defaultUnitPriceMilliYuan: 325,
  sourceSequence: "34",
  totalQuantity: 10,
});

expect(customerRows.map((row) => [row.skuCode, row.availabilityReason])).toEqual([
  ["TZX-034-1", "AVAILABLE"],
  ["TZX-034-2", "MANUALLY_UNAVAILABLE"],
  ["TZX-034-3", "SOLD_OUT"],
]);
expect(customerRows.find((row) => row.skuCode === "TZX-034-2")).toMatchObject({
  availableQuantity: 5,
  orderable: false,
  saleStatus: "NOT_SELLABLE",
});
expect(customerRows[0]).not.toHaveProperty("cargoUnitPriceMilliYuan");
expect(customerRows[0]).not.toHaveProperty("sourceSequence");
expect(customerRows[0]).not.toHaveProperty("totalQuantity");
```

Use distinct literals for `sku.name` and `specification` so the test catches the existing “SKU name as specification” bug. Verify an authenticated customer can load the image for a visible `NOT_SELLABLE` SKU, while unauthenticated access remains rejected.

- [ ] **Step 2: Run focused tests and witness RED**

Run:

```powershell
npm.cmd run test:integration -- tests/integration/catalog/catalog-queries.test.ts tests/integration/catalog/pricing.test.ts tests/integration/bulk-order/validation.test.ts
```

Expected: missing admin query module/type, filtered-out manual-unavailable row, missing reason/link/attribute fields, and denied image access for that row.

- [ ] **Step 3: Implement minimal aggregated queries and preserve the price/state-machine boundaries**

Compute available inventory from active reservations only and clamp at zero. Map availability in one pure helper:

```ts
export function resolveCatalogAvailability(
  saleStatus: "SELLABLE" | "NOT_SELLABLE",
  availableQuantity: number,
) {
  if (saleStatus === "NOT_SELLABLE") {
    return { availabilityReason: "MANUALLY_UNAVAILABLE" as const, orderable: false };
  }
  if (availableQuantity <= 0) {
    return { availabilityReason: "SOLD_OUT" as const, orderable: false };
  }
  return { availabilityReason: "AVAILABLE" as const, orderable: true };
}
```

Do not add a global temporary price. Keep and regression-test `resolveUnitPrice` in order submission so order-specific override remains the highest priority. Do not relax customer isolation or existing order validation.

- [ ] **Step 4: Run focused tests and witness GREEN**

Run the Step 2 command again, followed by:

```powershell
npm.cmd run test:integration -- tests/integration/orders/submission.test.ts tests/integration/identity/access-guards.test.ts
```

Expected: all tests pass and no customer-safe DTO exposes an admin-only field.

- [ ] **Step 5: Inspect and commit the atomic change**

```powershell
git add src/modules/catalog/admin-catalog.ts src/modules/catalog/customer-catalog.ts 'src/app/api/catalog-assets/[assetId]/route.ts' tests/integration/catalog tests/integration/bulk-order/validation.test.ts
git commit -m "feat: separate catalog query models by audience"
```

### Task 4: Remediate the administrator product and SKU workspace

**Files:**
- Modify: `src/app/(admin)/admin/catalog/page.tsx`
- Modify: `src/components/catalog/catalog-workspace.tsx`
- Modify: `src/components/catalog/catalog-results.tsx`
- Modify: `tests/unit/catalog/catalog-workspace.test.tsx`

**Interfaces:**
- `CatalogWorkspace.rows` becomes `AdminCatalogItem[]` from Task 3.
- Desktop presentation is a semantic table with nine information columns: sequence; product; specification/attributes; procurement price; total inventory; available inventory; cargo price; status; link.
- Below the wide desktop breakpoint, cards use the fixed order: product identity; specification/attributes; both prices; inventory; status; link.

- [ ] **Step 1: Write RED component tests for complete fields, search, long text, and responsive semantics**

Render a row with a long specification, three-decimal prices, and distinct link text. Assert the desktop table has the exact headers and the mobile card preserves the required order:

```ts
expect(screen.getByRole("table", { name: "商品与 SKU 列表" })).toBeInTheDocument();
for (const header of [
  "序号", "商品", "规格/属性", "采购价", "总库存", "可售库存", "货品价格", "状态", "链接",
]) {
  expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
}
expect(screen.getAllByText("¥0.325").length).toBeGreaterThan(0);
expect(screen.getAllByText("¥1.366").length).toBeGreaterThan(0);
expect(screen.getByRole("link", { name: "查看飞书商品" })).toHaveAttribute("href", "https://example.test/products/34");
```

Drive the search input with `34`, the full specification, product name, and `TZX-034-2`; each query must retain the expected row.

- [ ] **Step 2: Run the component test and witness RED**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

Expected: current five-column table lacks sequence, image/attributes, inventory, cargo price, and link and searches the wrong specification field.

- [ ] **Step 3: Implement the semantic table and ordered cards at the narrowest correct component boundary**

The page calls `listAdminCatalog()` instead of inline Drizzle selection. Use one `CatalogProductIdentity`, one `CatalogAttributes`, and one link renderer shared by the table and cards. Use `table-fixed`/`colgroup`, a two-line clamp for specification, `tabular-nums` plus right alignment for sequence/money/inventory, explicit image dimensions, and an accessible missing-image label. Use cards below `xl` rather than shrinking nine columns into the sidebar-constrained width. Do not add page-specific fonts, raw color values, decorative gradients, or page-level horizontal scrolling.

- [ ] **Step 4: Run the component test and related UI regression to witness GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx tests/unit/ui/management-primitives.test.tsx
```

Expected: the complete table and card assertions pass with no React or accessibility warnings.

- [ ] **Step 5: Inspect and commit the atomic change**

```powershell
git add 'src/app/(admin)/admin/catalog/page.tsx' src/components/catalog/catalog-workspace.tsx src/components/catalog/catalog-results.tsx tests/unit/catalog/catalog-workspace.test.tsx
git commit -m "feat: align admin catalog with Feishu fields"
```

### Task 5: Remediate the customer catalog without exposing internal facts

**Files:**
- Modify: `src/app/(customer)/portal/catalog/page.tsx`
- Modify: `src/components/catalog/customer-catalog-workspace.tsx`
- Modify: `tests/unit/catalog/catalog-workspace.test.tsx`

**Interfaces:**
- Consumes the Task 3 `CustomerCatalogItem` contract.
- Displays `specification` as the primary specification, with color/combination/weight as secondary labeled attributes.
- Uses exact status copy: `可售` for `AVAILABLE`, `不可售` for `MANUALLY_UNAVAILABLE`, and `售罄` for `SOLD_OUT`.
- Displays safe product link text and actual customer price; never renders admin-only fields.

- [ ] **Step 1: Write RED component tests for privacy, availability reasons, and long specifications**

Render three rows with a 100+ character specification and distinct `skuName`. Assert:

```ts
expect(screen.getAllByText(longSpecification).length).toBeGreaterThan(0);
expect(screen.queryByText("SKU 名称不能冒充规格")).not.toBeInTheDocument();
expect(screen.getAllByText("不可售").length).toBeGreaterThan(0);
expect(screen.getAllByText("售罄").length).toBeGreaterThan(0);
expect(screen.getByRole("link", { name: "查看商品详情" })).toHaveAttribute(
  "rel",
  expect.stringContaining("noopener"),
);
for (const internalLabel of ["序号", "采购价", "总库存", "货品价格"]) {
  expect(screen.queryByText(internalLabel)).not.toBeInTheDocument();
}
```

Assert long content lives in a wrapping/clamped container and the mobile DOM order is identity → attributes → actual price → available inventory → status → link.

- [ ] **Step 2: Run the component test and witness RED**

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

Expected: current component renders `skuName`, merges both unavailable states, and has no link/attribute presentation.

- [ ] **Step 3: Implement the customer-safe desktop table and mobile cards**

Use a task-focused table on wide screens and cards below `xl`. Keep touch targets at least 44px, use status text plus semantic color, allow controlled wrapping without overlapping the price/stock cells, and keep images at a stable aspect ratio. Preserve the server-side URL search and extend it to SKU, product name, specification, and source-safe link text only; do not search or serialize admin-only fields.

- [ ] **Step 4: Run unit and submission regressions to witness GREEN**

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
npm.cmd run test:integration -- tests/integration/bulk-order/validation.test.ts tests/integration/orders/submission.test.ts
```

Expected: UI assertions pass, and unavailable/sold-out SKUs remain rejected by the unchanged order validation path.

- [ ] **Step 5: Inspect and commit the atomic change**

```powershell
git add 'src/app/(customer)/portal/catalog/page.tsx' src/components/catalog/customer-catalog-workspace.tsx tests/unit/catalog/catalog-workspace.test.tsx
git commit -m "fix: make customer catalog accurate and private"
```

### Task 6: Make account management semantic and strengthen navigation hierarchy

**Files:**
- Modify: `src/components/accounts/account-management-workspace.tsx`
- Modify: `src/components/layout/navigation-section.tsx`
- Modify: `src/components/ui/tabs.tsx`
- Modify: `tests/unit/accounts/account-management.test.tsx`
- Modify: `tests/unit/ui/merchant-shell.test.tsx`

**Interfaces:**
- Desktop account view is a native semantic table with columns: name, email, role, customer, store count, status, latest login, actions.
- Mobile/tablet account view remains summary cards plus the existing details drawer.
- Tab overflow is enabled only below the desktop breakpoint.
- `NavigationSection` receives/derives `isCurrentGroup` and visually strengthens only the current group while preserving route order, persisted disclosure, auto-open, keyboard order, and `aria-current="page"`.

- [ ] **Step 1: Write RED tests for native table semantics, column alignment, and current-group hierarchy**

Assert the desktop account surface is a real table and carries the required headers:

```ts
const table = screen.getByRole("table", { name: "账号列表" });
expect(table.tagName).toBe("TABLE");
expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
  "姓名", "邮箱", "角色", "所属客户", "店铺数", "状态", "最近登录", "操作",
]);
```

Assert a long email wraps inside its cell, the action column owns a fixed narrow width token/class, desktop tabs do not have horizontal overflow, and the active system-management group has a distinct current-group marker while its current link keeps `aria-current="page"`.

- [ ] **Step 2: Run focused tests and witness RED**

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx tests/unit/ui/merchant-shell.test.tsx
```

Expected: current ARIA/CSS-grid pseudo-table is not a native table, tab overflow is unconditional, and active group heading has no distinct state.

- [ ] **Step 3: Implement semantic desktop structure and hierarchy-preserving navigation styles**

Use the shared `Table` primitives, one row renderer, a fixed `colgroup`, `overflow-wrap:anywhere` for email, and cards below `xl`. Preserve all existing drawer actions and permissions. Add current-group typography/background/border treatment using semantic design tokens only; do not change menu labels, ordering, URLs, localStorage key, focus order, or default collapsed behavior.

- [ ] **Step 4: Run focused tests and broader shell regressions to witness GREEN**

```powershell
npm.cmd test -- tests/unit/accounts/account-management.test.tsx tests/unit/ui/merchant-shell.test.tsx tests/unit/ui/management-primitives.test.tsx
```

Expected: semantic/account/nav assertions pass with no console warnings.

- [ ] **Step 5: Inspect and commit the atomic change**

```powershell
git add src/components/accounts/account-management-workspace.tsx src/components/layout/navigation-section.tsx src/components/ui/tabs.tsx tests/unit/accounts/account-management.test.tsx tests/unit/ui/merchant-shell.test.tsx
git commit -m "fix: align account table and navigation hierarchy"
```

### Task 7: Add field-aligned responsive, accessibility, and visual acceptance coverage

**Files:**
- Modify: `tests/e2e/feishu-cargo-migration.spec.ts`
- Modify: `tests/e2e/admin-management.spec.ts`
- Modify: `tests/e2e/customer-catalog.spec.ts`
- Modify: `tests/e2e/ui-v2-responsive.spec.ts`
- Modify: `tests/e2e/merchant-center-visual.spec.ts`
- Modify: affected `tests/e2e/*-snapshots/*.png`

**Interfaces:**
- Playwright fixtures include 74 sequences/140 SKUs, `TZX-034-1/2/3`, one 100+ character specification, one long email, ¥0.325 procurement price, ¥1.366 cargo price, a manual-unavailable SKU with inventory, and a sold-out SKU.
- Every covered page installs `console`, `pageerror`, and hydration-error collectors before navigation.
- Width matrix is exactly 1440×900, 1920×1080, 430×900, 390×844, and 360×800.
- Visual comparisons use no masks and retain deterministic local data/assets.

- [ ] **Step 1: Write/extend E2E assertions and witness RED against the current rendered behavior**

For `/admin/catalog`, `/admin/accounts`, and `/portal/catalog`, assert:

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
expect(consoleErrors).toEqual([]);
expect(pageErrors).toEqual([]);
expect(hydrationErrors).toEqual([]);
expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
```

Add bounding-box non-overlap assertions between long specification, price, inventory, and status cells/cards. Assert the database confirmation leaves write-target call count zero and returns 74 sequences/140 SKUs.

Run each focused spec once without snapshot updates and record the expected layout/status/count failures.

- [ ] **Step 2: Make only test-fixture/selectors changes needed for deterministic acceptance**

Do not alter production behavior in this task. Use stable role/name selectors, deterministic timestamps, local catalog assets, and exact viewport loops. Keep screenshots unmasked and name them by route plus viewport, for example `admin-catalog-1440x900.png` and `customer-catalog-390x844.png`.

- [ ] **Step 3: Run focused E2E and update visual baselines once**

```powershell
npm.cmd run test:e2e -- tests/e2e/feishu-cargo-migration.spec.ts tests/e2e/admin-management.spec.ts tests/e2e/customer-catalog.spec.ts tests/e2e/ui-v2-responsive.spec.ts
npm.cmd run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --update-snapshots
```

Expected: all functional, axe, overflow, console, hydration, and screenshot assertions pass at the exact viewport matrix.

- [ ] **Step 4: Run the bounded Impeccable visual inspection and detector pass**

Capture desktop and mobile together, inspect once for overlap, hierarchy, wrapping, and status clarity, fix the complete defect batch in the owning earlier component (with its focused RED/GREEN test), then confirm with at most one more screenshot round. Run the required one-time detector only after UI is finished:

```powershell
node C:\Users\AKSSINA\.agents\skills\impeccable\scripts\detect.mjs --json src/components/catalog src/components/accounts/account-management-workspace.tsx src/components/layout/navigation-section.tsx src/components/ui/tabs.tsx
```

Expected: no unapproved detector findings; any narrow intentional exception is documented in the task report.

- [ ] **Step 5: Commit deterministic E2E coverage and screenshots**

```powershell
git add tests/e2e
git commit -m "test: cover field-aligned catalog UI"
```

## Final Whole-Branch Verification

After all seven task reviews are clean, run a whole-branch review from `git merge-base main HEAD` through `HEAD`, address one consolidated fix wave, and perform one scoped re-review. Then run fresh, complete evidence commands:

```powershell
npm.cmd test
npm.cmd run test:integration -- --no-file-parallelism
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run test:e2e -- tests/e2e/feishu-cargo-migration.spec.ts tests/e2e/admin-management.spec.ts tests/e2e/customer-catalog.spec.ts tests/e2e/ui-v2-responsive.spec.ts tests/e2e/merchant-center-visual.spec.ts
git diff --check main...HEAD
git status --short
```

The integration configuration already fixes `maxWorkers: 1`; `--no-file-parallelism` additionally makes file execution serial. Audit tracked configuration and the branch diff for `FEISHU_CARGO_WRITES_ENABLED`; the only enabled value permitted in production/runtime/E2E configuration is `false`. Unit tests may construct an in-memory writer configuration solely to prove the disabled guard, but no E2E or remediation flow may call a writer.

Record screenshot paths, test counts, command exit codes, console/axe/overflow evidence, detector output, known risks, and the recommended merge target. Do not deploy, push, merge, or change production.

## Self-Review

- Spec coverage: the plan covers three new structured fields, 74 groups/140 SKUs, one-image-per-SKU, read-only idempotent backfill, independent status/inventory facts, admin catalog, customer privacy, account semantics, sidebar hierarchy, desktop/mobile layouts, axe/overflow/console/hydration checks, and unmasked screenshots.
- Placeholder scan: every code change has named files, concrete interfaces, RED/GREEN commands, expected failure causes, and commit boundaries.
- Type consistency: `sourceSequence`, `linkText`, and `cargoUnitPriceMilliYuan` are product fields; `defaultUnitPriceMilliYuan` remains the SKU procurement/default price; customer items expose neither internal price.
- Boundary consistency: existing inventory is preserved during metadata backfill, new SKU inventory is initialized once, and general catalog pricing does not invent an order-specific override scope.
- Execution selection: the delegation already requires subagent-driven development, so execution proceeds without another user-choice gate.
