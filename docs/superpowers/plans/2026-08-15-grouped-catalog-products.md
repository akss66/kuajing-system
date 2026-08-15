# Grouped Catalog Products Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present the Feishu catalog as 74 product/source-sequence groups containing 140 SKU variants in both administrator and customer interfaces, and safely repair the already-imported production data without writing to Feishu.

**Architecture:** Keep `products` as the parent record and `skus.product_id` as the one-to-many variant relation. Add one shared grouping adapter consumed by both UIs, a read-only Feishu field-refresh service that validates the complete SKU set before changing local PostgreSQL records, and a legacy snapshot migration that can recover parent sequence/link fields without overwriting non-null values. UI components receive groups, render parent facts once, and render SKU-specific price, inventory, attributes and status per variant.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Drizzle ORM, PostgreSQL, Vitest, Playwright, Tailwind CSS, existing Radix/shadcn primitives.

## Global Constraints

- Read the relevant local Next.js 16 guide in `node_modules/next/dist/docs/` before modifying App Router pages or client components.
- Feishu is read-only: no implementation or test may call `writeRange`, styling, dimension, or any other Feishu mutation endpoint.
- `FEISHU_CARGO_WRITES_ENABLED=false` remains unchanged in production.
- One source sequence maps to one `products` parent; one parent contains one or more `skus` variants.
- Inventory balances, reservations, movements, orders, prices and audit history must not be reset during regrouping.
- Existing routes, permissions and order state machines remain unchanged.
- Desktop must have no page-level horizontal overflow; 430×900, 390×844 and 360×800 use grouped cards, not compressed desktop tables.
- Tests follow RED → GREEN, and each task ends in a focused commit.

---

### Task 1: Shared product-group contract and query identity

**Files:**
- Create: `src/modules/catalog/product-groups.ts`
- Modify: `src/modules/catalog/admin-catalog.ts`
- Modify: `src/modules/catalog/customer-catalog.ts`
- Create: `tests/unit/catalog/product-groups.test.ts`
- Modify: `tests/integration/catalog/catalog-queries.test.ts`

**Interfaces:**
- Produces:

```ts
export type CatalogGroupableItem = {
  id: string;
  productId: string;
  productName: string;
  sourceSequence: string | null;
  linkText: string | null;
  productUrl: string | null;
  skuCode: string;
};

export type CatalogProductGroup<T extends CatalogGroupableItem> = {
  productId: string;
  productName: string;
  sourceSequence: string | null;
  linkText: string | null;
  productUrl: string | null;
  variants: T[];
};

export function groupCatalogItems<T extends CatalogGroupableItem>(
  items: readonly T[],
): CatalogProductGroup<T>[];

export function filterCatalogGroups<T extends CatalogGroupableItem>(
  groups: readonly CatalogProductGroup<T>[],
  query: string,
  variantSearchValues: (variant: T) => Array<string | null>,
): CatalogProductGroup<T>[];
```

- `AdminCatalogItem` and `CustomerCatalogItem` both gain `productId` and `sourceSequence` from the joined `products` row.
- Group order is stable by numeric-aware `sourceSequence`, then product name, then product ID; variant order is stable by SKU code.

- [ ] **Step 1: Write the failing unit tests**

```ts
it("groups three SKU variants under one product/source sequence", () => {
  const groups = groupCatalogItems([
    item({ id: "sku-1", productId: "product-1", skuCode: "TZX-001-1", sourceSequence: "1" }),
    item({ id: "sku-2", productId: "product-1", skuCode: "TZX-001-2", sourceSequence: "1" }),
    item({ id: "sku-3", productId: "product-1", skuCode: "TZX-001-3", sourceSequence: "1" }),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].variants.map((variant) => variant.skuCode)).toEqual([
    "TZX-001-1",
    "TZX-001-2",
    "TZX-001-3",
  ]);
});

it("keeps the complete group when one SKU matches search", () => {
  const filtered = filterCatalogGroups(groups, "001-2", (variant) => [variant.skuCode]);
  expect(filtered[0].variants).toHaveLength(3);
});
```

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/unit/catalog/product-groups.test.ts`

Expected: FAIL because `product-groups.ts` and the grouping exports do not exist.

- [ ] **Step 3: Add query identity and minimal grouping implementation**

Add `products.id` as `productId` and `products.sourceSequence` to both query projections. Implement grouping with a `Map<string, CatalogProductGroup<T>>`; never group by product name or SKU prefix.

- [ ] **Step 4: Run focused GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/product-groups.test.ts
npm.cmd run test:integration -- tests/integration/catalog/catalog-queries.test.ts
npm.cmd run typecheck
```

Expected: grouping unit tests and catalog query integration tests pass; both audience models return the same parent identity without exposing admin-only price fields to customers.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/catalog/product-groups.ts src/modules/catalog/admin-catalog.ts src/modules/catalog/customer-catalog.ts tests/unit/catalog/product-groups.test.ts tests/integration/catalog/catalog-queries.test.ts
git commit -m "feat: model catalog product groups"
```

---

### Task 2: Legacy snapshot repair and read-only Feishu field refresh

**Files:**
- Create: `drizzle/0022_backfill_feishu_product_fields.sql`
- Create: `drizzle/meta/0022_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Create: `src/modules/feishu/catalog-field-refresh.ts`
- Modify: `src/modules/feishu/cargo-parser.ts`
- Create: `scripts/refresh-feishu-catalog-fields.ts`
- Modify: `package.json`
- Create: `tests/integration/schema/feishu-field-backfill.test.ts`
- Create: `tests/integration/feishu/catalog-field-refresh.test.ts`
- Modify: `tests/unit/feishu/cargo-parser.test.ts`

**Interfaces:**
- Produces:

```ts
export type CatalogFieldRefreshPreview = {
  sourceSequenceCount: number;
  skuCount: number;
  matchedSkuCount: number;
  productsToMerge: number;
};

export type CatalogFieldRefreshReadPort = Pick<
  FeishuSourcePort,
  "resolveWikiSpreadsheet" | "listSheets" | "readRangeDetails"
>;

export function createCatalogFieldRefreshService(database?: typeof db): {
  preview(input: {
    client: CatalogFieldRefreshReadPort;
    sourceSheetId: string;
    sourceWikiToken: string;
    expectedSourceSequenceCount: number;
    expectedSkuCount: number;
  }): Promise<CatalogFieldRefreshPreview>;
  apply(input: {
    actorUserId: string;
    client: CatalogFieldRefreshReadPort;
    reason: string;
    sourceSheetId: string;
    sourceWikiToken: string;
    expectedSourceSequenceCount: number;
    expectedSkuCount: number;
  }): Promise<CatalogFieldRefreshPreview>;
};
```

- The read port deliberately omits all Feishu mutation methods and media download.
- The parser must recognize the production header form `货品价格（采购价+头程+打包材料…）` as the cargo-price column while continuing to distinguish it from `采购价`; normalize whitespace and accept the `货品价格` prefix with either Chinese or ASCII parentheses.
- `apply` reads and parses before opening the PostgreSQL transaction, then locks the catalog with an advisory transaction lock.
- Exact preconditions: 74 distinct source sequences, 140 distinct source SKU codes, no blocking parser issue, and exact equality between the source SKU set and the existing database SKU set.
- For each source sequence, choose the existing product containing the greatest number of that sequence’s SKUs (stable tie-break by product ID), update its parent fields, and reassign every group SKU to it. Do not delete orphan product rows in this repair.
- Update current SKU descriptive/source fields and prices, but do not update inventory balances, reservations or movements and do not replace image assets.
- Insert one `CATALOG_FIELDS_REFRESHED_FROM_FEISHU` audit record with counts and the supplied reason.

- [ ] **Step 1: Extend the disposable migration RED test for the legacy shape**

The stored row must omit `sourceSequence` and `cargoUnitPriceMilliYuan`, include legacy `productGroupKey: "34"`, and prove that 0022 backfills `source_sequence` and `link_text` while leaving missing cargo price null. It must also prove partial SKU matches and manually populated non-null fields are not overwritten.

- [ ] **Step 2: Write field-refresh RED integration tests**

```ts
it("merges split products into one source sequence without changing inventory history", async () => {
  const before = await readInventoryFacts();
  const result = await service.apply(validInput);
  expect(result).toMatchObject({ sourceSequenceCount: 74, skuCount: 140 });
  expect(await productIdsFor(["TZX-001-1", "TZX-001-2", "TZX-001-3"]))
    .toEqual(["one-canonical-product-id"]);
  expect(await readInventoryFacts()).toEqual(before);
  expect(feishuWriteCalls).toHaveLength(0);
});

it("leaves PostgreSQL unchanged when source and database SKU sets differ", async () => {
  await expect(service.apply(missingSkuInput)).rejects.toThrow("SKU_SET_MISMATCH");
  expect(await readCatalogFacts()).toEqual(beforeCatalogFacts);
});
```

Add a parser regression using an actual-shaped header cell such as `货品价格\n（采购价+头程+打包材料+人工费）`; assert one row parses with its independent `cargoUnitPriceMilliYuan` and `defaultUnitPriceMilliYuan` values preserved separately.

- [ ] **Step 3: Run RED**

Run:

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts
npm.cmd run test:integration -- tests/integration/schema/feishu-field-backfill.test.ts tests/integration/feishu/catalog-field-refresh.test.ts
```

Expected: FAIL because the migration and refresh service are missing or do not understand the legacy snapshot shape, and the current parser rejects the production long-form cargo-price header.

- [ ] **Step 4: Implement 0022 and refresh service**

0022 uses `COALESCE(row_data->>'sourceSequence', row_data->>'productGroupKey')` for the legacy parent sequence, only fills null product fields, rejects partial sibling matches, and treats absent legacy cargo price as null. Update header matching so the production long-form `货品价格` heading maps only to `cargoPrice`. The service reads the live source with `readFeishuSourceSnapshot`, parses with `parseLegacyCargoSheet`, performs the exact-set checks, then updates local database rows only.

- [ ] **Step 5: Add the guarded operations command**

Add package script:

```json
"ops:refresh-feishu-catalog-fields": "tsx scripts/refresh-feishu-catalog-fields.ts"
```

The command defaults to preview. Mutation requires all of:

```text
--apply
--expected-source-sequences=74
--expected-skus=140
--reason=<non-empty operator reason>
```

It resolves the configured or latest imported source sheet and the single active bootstrap super-admin for audit attribution. It prints counts only and never prints Feishu tokens, URLs containing tokens, app secrets, image bytes or customer PII.

- [ ] **Step 6: Run focused GREEN and safety scans**

Run:

```powershell
npm.cmd test -- tests/unit/feishu/cargo-parser.test.ts
npm.cmd run test:integration -- tests/integration/schema/feishu-field-backfill.test.ts tests/integration/feishu/catalog-field-refresh.test.ts
rg -n "writeRange|formatRange|updateDimension|batchUpdate" src/modules/feishu/catalog-field-refresh.ts scripts/refresh-feishu-catalog-fields.ts
npm.cmd run typecheck
npm.cmd run lint
```

Expected: tests pass; the write-method scan has no matches; typecheck and lint pass.

- [ ] **Step 7: Commit**

```powershell
git add drizzle/0022_backfill_feishu_product_fields.sql drizzle/meta/0022_snapshot.json drizzle/meta/_journal.json src/modules/feishu/catalog-field-refresh.ts src/modules/feishu/cargo-parser.ts scripts/refresh-feishu-catalog-fields.ts package.json tests/integration/schema/feishu-field-backfill.test.ts tests/integration/feishu/catalog-field-refresh.test.ts tests/unit/feishu/cargo-parser.test.ts
git commit -m "fix: regroup imported Feishu catalog products"
```

---

### Task 3: Administrator grouped product/SKU workspace

**Files:**
- Modify: `src/components/catalog/catalog-workspace.tsx`
- Modify: `src/components/catalog/catalog-results.tsx`
- Modify: `tests/unit/catalog/catalog-workspace.test.tsx`
- Modify: `tests/e2e/ui-v2-catalog-accounts.spec.ts`

**Interfaces:**
- Consumes `groupCatalogItems`, `filterCatalogGroups`, `CatalogProductGroup<AdminCatalogItem>` and the `productId` query field from Task 1.
- Produces grouped desktop table and grouped mobile cards without changing mutation drawer action contracts.

- [ ] **Step 1: Write UI RED tests**

Render source sequence 1 with three variants and assert:

```ts
expect(screen.getAllByText("序号 1")).toHaveLength(1);
expect(screen.getByText("TZX-001-1")).toBeVisible();
expect(screen.getByText("TZX-001-2")).toBeVisible();
expect(screen.getByText("TZX-001-3")).toBeVisible();
expect(screen.getByText("1 个商品 / 3 个 SKU")).toBeVisible();
```

Search for `TZX-001-2` and assert all three variant codes remain rendered in the one retained group.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx`

Expected: FAIL because current output repeats the source sequence and product identity once per SKU.

- [ ] **Step 3: Implement grouped desktop table**

Use a semantic table with parent cells rendered once through `rowSpan={group.variants.length}` for source sequence, product name, cargo price and product link. Each variant row renders its own image/SKU, specification/attributes, purchase price, combined total/available inventory, and sale status. Add a visible group boundary without using saturated row background colors.

- [ ] **Step 4: Implement grouped mobile cards**

Render one `<li>` per product group. The card header contains source sequence, name, shared cargo price and shared link. A nested semantic list renders every SKU image/code, attributes, purchase price, total/available inventory and status. All SKU variants remain visible by default.

- [ ] **Step 5: Run GREEN and focused browser checks**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
npm.cmd run test:e2e -- tests/e2e/ui-v2-catalog-accounts.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
```

Expected: grouped unit assertions pass; administrator desktop/mobile routes have no overlap, page-level horizontal overflow, hydration error or serious/critical axe finding.

- [ ] **Step 6: Commit**

```powershell
git add src/components/catalog/catalog-workspace.tsx src/components/catalog/catalog-results.tsx tests/unit/catalog/catalog-workspace.test.tsx tests/e2e/ui-v2-catalog-accounts.spec.ts
git commit -m "feat: group admin catalog by source product"
```

---

### Task 4: Customer grouped catalog cards and variant comparison

**Files:**
- Modify: `src/app/(customer)/portal/catalog/page.tsx`
- Modify: `src/components/catalog/customer-catalog-workspace.tsx`
- Modify: `tests/unit/catalog/catalog-workspace.test.tsx`
- Modify: `tests/e2e/customer-catalog.spec.ts`

**Interfaces:**
- Consumes `groupCatalogItems`, `filterCatalogGroups`, `CatalogProductGroup<CustomerCatalogItem>` and query fields from Task 1.
- Does not add quantity inputs, cart state, submission actions or new routes.

- [ ] **Step 1: Write customer grouping RED tests**

Assert one product name/link header and three visible SKU variant sections for a three-SKU product. Assert `1 个商品 / 3 个 SKU`. Search for one SKU and assert the retained card still shows its siblings. Assert customer markup contains no `sourceSequence`, total inventory, procurement-cost label, or cargo-price label.

- [ ] **Step 2: Run RED**

Run: `npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx`

Expected: FAIL because the current component renders one table row/card per SKU and counts only flat results.

- [ ] **Step 3: Move filtering to complete groups**

The page loads the complete customer catalog for the authenticated customer. The workspace groups first, then calls `filterCatalogGroups`; remove the flat row filter that drops sibling variants.

- [ ] **Step 4: Implement grouped customer presentation**

Desktop: render one product section with shared name/link header and an inner semantic variant table for image/SKU, attributes, actual customer price, available inventory and availability status.

Mobile: render one product card with the same shared header and a vertical list of variant panels. Preserve `AVAILABLE`, `MANUALLY_UNAVAILABLE` and `SOLD_OUT` semantics and keep unavailable variants visible but non-orderable under existing rules.

- [ ] **Step 5: Run GREEN and responsive checks**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
npm.cmd run test:e2e -- tests/e2e/customer-catalog.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
```

Expected: customer grouping and privacy assertions pass at desktop, 430, 390 and 360 widths with no text collision or horizontal page overflow.

- [ ] **Step 6: Commit**

```powershell
git add 'src/app/(customer)/portal/catalog/page.tsx' src/components/catalog/customer-catalog-workspace.tsx tests/unit/catalog/catalog-workspace.test.tsx tests/e2e/customer-catalog.spec.ts
git commit -m "feat: group customer catalog SKU variants"
```

---

### Task 5: Integrated acceptance, production repair and release

**Files:**
- Modify only when a failing acceptance test proves a regression in the files owned by Tasks 1–4.
- Append ignored task report under `.superpowers/sdd/2026-08-15-grouped-catalog-products/`.

**Interfaces:**
- Consumes all prior task commits.
- Produces one reviewed branch, a database backup, a new immutable Docker image tag, and verified production counts.

- [ ] **Step 1: Run complete local quality gates**

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run test:e2e -- --workers 1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
git diff --check
```

Expected: all commands pass; E2E has zero unexpected failures or runtime skips.

- [ ] **Step 2: Review screenshots once in a bounded batch**

Capture administrator and customer catalog at 1440×900, 390×844 and 360×800. Confirm one parent per source sequence, all variants visible, no duplicated parent facts, no text collision, no masking and no page-level horizontal overflow. Run the Impeccable detector once on changed UI files and require `[]`.

- [ ] **Step 3: Create production backup and deploy immutable release**

Create a timestamped PostgreSQL custom-format backup. Build the web/worker shared image once using the final commit short SHA, apply 0022 through the normal Drizzle migration command, recreate only the Tongzhouxing web/worker containers, and leave PostgreSQL plus dyflow untouched.

- [ ] **Step 4: Run read-only production preview**

```text
npm run ops:refresh-feishu-catalog-fields -- --expected-source-sequences=74 --expected-skus=140
```

Expected: preview reports 74 source sequences, 140 source SKUs, 140 matched database SKUs and the expected merge count. It performs no database or Feishu mutation.

- [ ] **Step 5: Apply local-database-only refresh**

```text
npm run ops:refresh-feishu-catalog-fields -- --apply --expected-source-sequences=74 --expected-skus=140 --reason="按已确认飞书货盘只读回填商品分组与字段"
```

Expected: the command updates local PostgreSQL and audit history only. Verify `products.source_sequence` has 74 distinct non-null values associated with the 140 SKUs, all mapped products have link text and cargo price, inventory totals/movements are unchanged, and no Feishu outbox write event was created.

- [ ] **Step 6: Verify production safety and health**

Verify:

```text
GET https://shop.tzxai.top/api/health -> {"status":"ok"}
FEISHU_CARGO_WRITES_ENABLED=false
web healthy
worker running
dyflow containers unchanged and healthy
```

Smoke-test administrator and customer catalog grouping with the production session. Record the deployed commit, image digest, backup path, migration ledger count, 74/140 mapping counts and rollback command in the ignored task report.

- [ ] **Step 7: Final review and handoff**

Request independent correctness and UI review. Resolve every Critical/Important finding with a fresh RED→GREEN cycle. Do not claim completion until the reviewers pass and production reports 74 grouped products / 140 SKU variants with Feishu writes still disabled.
