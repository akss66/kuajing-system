# Catalog Sale Status Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent `全部 / 可售 / 不可售` SKU filtering to the grouped administrator and customer catalog workspaces without changing catalog data or business statuses.

**Architecture:** Extend the shared product-group module with a pure variant-filter function that removes nonmatching variants and then removes empty groups. Add one reusable accessible status control; each workspace applies text search to complete groups first and status filtering second, using its own availability predicate.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript, Tailwind CSS, Vitest/Testing Library, Playwright, axe-core.

## Global Constraints

- Group only by `productId`; never infer grouping from SKU prefixes or product names.
- Search matching any variant keeps the complete product group before status filtering.
- Status filtering acts at SKU level and removes empty product groups.
- Administrator `SELLABLE` is可售; `NOT_SELLABLE` is不可售.
- Customer `AVAILABLE` is可售; `MANUALLY_UNAVAILABLE` and `SOLD_OUT` are不可售, while their detailed badges remain unchanged.
- Counts always describe visible groups and visible SKU variants.
- Filter state is client-only, defaults to `ALL`, is not written to the URL/database/Feishu, and resets on refresh.
- No catalog mutation, permission, price, inventory, route, order, or Feishu behavior changes.
- Mobile controls remain at least 44px high; desktop/430/390/360 have no page-level horizontal overflow, text collision, hydration/page/unhandled console errors, or axe serious/critical findings.

---

### Task 1: Shared variant filter and administrator status control

**Files:**
- Modify: `src/modules/catalog/product-groups.ts`
- Create: `src/components/catalog/catalog-sale-status-filter.tsx`
- Modify: `src/components/catalog/catalog-workspace.tsx`
- Modify: `tests/unit/catalog/product-groups.test.ts`
- Modify: `tests/unit/catalog/catalog-workspace.test.tsx`
- Modify: `tests/e2e/ui-v2-catalog-accounts.spec.ts`

**Interfaces:**
- Consumes: `CatalogProductGroup<T>`, `filterCatalogGroups(...)`, and `AdminCatalogItem.saleStatus`.
- Produces:

```ts
export type CatalogSaleStatusFilter = "ALL" | "SELLABLE" | "NOT_SELLABLE";

export function filterCatalogGroupVariants<T extends CatalogGroupableItem>(
  groups: readonly CatalogProductGroup<T>[],
  status: CatalogSaleStatusFilter,
  isSellable: (variant: T) => boolean,
): CatalogProductGroup<T>[];

export function CatalogSaleStatusFilterControl(props: {
  value: CatalogSaleStatusFilter;
  onValueChange: (value: CatalogSaleStatusFilter) => void;
}): React.JSX.Element;
```

- The pure function preserves group order and variant order, returns every variant for `ALL`, and returns cloned group objects with only matching variants for the other statuses.

- [ ] **Step 1: Write shared filter RED tests**

Add tests using one mixed product plus one unavailable-only product:

```ts
it("filters variants by sale status and removes empty product groups", () => {
  const sellable = filterCatalogGroupVariants(groups, "SELLABLE", (item) => item.sellable);
  expect(sellable).toHaveLength(1);
  expect(sellable[0]!.variants.map((item) => item.skuCode)).toEqual(["TZX-001-1"]);

  const unavailable = filterCatalogGroupVariants(
    groups,
    "NOT_SELLABLE",
    (item) => item.sellable,
  );
  expect(unavailable.flatMap((group) => group.variants.map((item) => item.skuCode)))
    .toEqual(["TZX-001-2", "TZX-002"]);
});
```

- [ ] **Step 2: Run the shared RED**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/product-groups.test.ts
```

Expected: FAIL because `filterCatalogGroupVariants` and `CatalogSaleStatusFilter` do not exist.

- [ ] **Step 3: Implement the pure shared filter**

Implement:

```ts
export function filterCatalogGroupVariants<T extends CatalogGroupableItem>(
  groups: readonly CatalogProductGroup<T>[],
  status: CatalogSaleStatusFilter,
  isSellable: (variant: T) => boolean,
) {
  if (status === "ALL") return groups.map((group) => ({ ...group, variants: [...group.variants] }));

  const expected = status === "SELLABLE";
  return groups.flatMap((group) => {
    const variants = group.variants.filter((variant) => isSellable(variant) === expected);
    return variants.length > 0 ? [{ ...group, variants }] : [];
  });
}
```

- [ ] **Step 4: Add administrator UI RED tests**

Render one mixed product and assert the accessible group `销售状态筛选` has `全部`, `可售`, and `不可售`. Click `可售`; assert only the sellable SKU remains and the count updates to `1 个商品 / 1 个 SKU`. Click `不可售`; assert the unavailable sibling remains. Combine a SKU query with a status click and assert search first preserves siblings before status filtering.

- [ ] **Step 5: Run administrator RED**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

Expected: FAIL because the status control is absent and the workspace only applies text search.

- [ ] **Step 6: Implement the shared control and administrator state**

Create `CatalogSaleStatusFilterControl` as a labeled `<fieldset>` with three buttons. Each button uses `aria-pressed`, an explicit accessible label, and `min-h-11`; selected and unselected states differ by text/outline as well as color.

In `CatalogWorkspace`, add:

```ts
const [saleStatus, setSaleStatus] = useState<CatalogSaleStatusFilter>("ALL");
const searchedGroups = useMemo(
  () => filterCatalogGroups(groups, query, adminVariantSearchValues),
  [groups, query],
);
const filteredGroups = useMemo(
  () => filterCatalogGroupVariants(
    searchedGroups,
    saleStatus,
    (variant) => variant.saleStatus === "SELLABLE",
  ),
  [saleStatus, searchedGroups],
);
```

Place the control in the existing search/action section with responsive wrapping. When results are empty because of status filtering, render filtered-empty copy and a button that restores `ALL`; preserve the existing clear-search action when only query is active.

- [ ] **Step 7: Extend administrator browser coverage**

In `ui-v2-catalog-accounts.spec.ts`, select `可售` and `不可售` on desktop and mobile, verify visible SKU/status/count changes, then combine search plus filter. Assert each control is at least 44px high and preserve existing overflow/axe/console/hydration checks.

- [ ] **Step 8: Run Task 1 GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/product-groups.test.ts tests/unit/catalog/catalog-workspace.test.tsx
npm.cmd run test:e2e -- tests/e2e/ui-v2-catalog-accounts.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: unit and browser checks pass with no accessibility or responsive regression.

- [ ] **Step 9: Commit Task 1**

```powershell
git add src/modules/catalog/product-groups.ts src/components/catalog/catalog-sale-status-filter.tsx src/components/catalog/catalog-workspace.tsx tests/unit/catalog/product-groups.test.ts tests/unit/catalog/catalog-workspace.test.tsx tests/e2e/ui-v2-catalog-accounts.spec.ts
git commit -m "feat: filter admin catalog by sale status"
```

---

### Task 2: Customer availability filter and responsive acceptance

**Files:**
- Modify: `src/components/catalog/customer-catalog-workspace.tsx`
- Modify: `tests/unit/catalog/catalog-workspace.test.tsx`
- Modify: `tests/e2e/customer-catalog.spec.ts`

**Interfaces:**
- Consumes: `CatalogSaleStatusFilter`, `filterCatalogGroupVariants(...)`, `CatalogSaleStatusFilterControl`, and `CustomerCatalogItem.availabilityReason`.
- Produces: customer-safe grouped SKU filtering where only `availabilityReason === "AVAILABLE"` is considered sellable.

- [ ] **Step 1: Write customer filter RED tests**

Use one product containing `AVAILABLE`, `MANUALLY_UNAVAILABLE`, and `SOLD_OUT` variants. Assert:

```ts
expect(screen.getByRole("group", { name: "销售状态筛选" })).toBeVisible();
fireEvent.click(screen.getByRole("button", { name: "只看不可售 SKU" }));
expect(screen.queryByText("TZX-034-1")).not.toBeInTheDocument();
expect(screen.getByText("TZX-034-2")).toBeVisible();
expect(screen.getByText("TZX-034-3")).toBeVisible();
expect(screen.getByText("1 个商品 / 2 个 SKU")).toBeVisible();
```

Also assert the detailed badges still read `不可售` and `售罄`, and the DOM still omits source sequence, total inventory, purchase price, and cargo price.

- [ ] **Step 2: Run customer RED**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/catalog-workspace.test.tsx
```

Expected: FAIL because the customer workspace has no sale-status control.

- [ ] **Step 3: Implement customer filter composition**

Add `saleStatus` state defaulting to `ALL`. Keep the current group-first text search, then apply:

```ts
const filteredGroups = useMemo(
  () => filterCatalogGroupVariants(
    searchedGroups,
    saleStatus,
    (variant) => variant.availabilityReason === "AVAILABLE",
  ),
  [saleStatus, searchedGroups],
);
```

Render `CatalogSaleStatusFilterControl` beside/below the existing search field. Keep `availabilityLabel` and `availabilityClassName` unchanged so unavailable reasons remain distinct. Update filtered empty-state actions to reset query and/or status without a server request.

- [ ] **Step 4: Extend customer browser acceptance**

In `customer-catalog.spec.ts`, verify on desktop and the existing 430/390/360 loops:

- `可售` removes manually unavailable and sold-out variants.
- `不可售` includes both detailed unavailable reasons and hides available variants.
- a mixed product remains a single product section/card.
- counts reflect visible groups/SKUs.
- customer-private admin fields remain absent.
- controls are at least 44px; no horizontal overflow, axe serious/critical, console, page, or hydration errors.

- [ ] **Step 5: Run Task 2 GREEN**

Run:

```powershell
npm.cmd test -- tests/unit/catalog/product-groups.test.ts tests/unit/catalog/catalog-workspace.test.tsx
npm.cmd run test:e2e -- tests/e2e/customer-catalog.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: all checks pass and the customer view exposes only customer-safe fields.

- [ ] **Step 6: Run Impeccable detector once**

Run the project detector against only:

```text
src/components/catalog/catalog-sale-status-filter.tsx
src/components/catalog/catalog-workspace.tsx
src/components/catalog/customer-catalog-workspace.tsx
```

Expected JSON result: `[]`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add src/components/catalog/customer-catalog-workspace.tsx tests/unit/catalog/catalog-workspace.test.tsx tests/e2e/customer-catalog.spec.ts
git commit -m "feat: filter customer catalog by availability"
```

---

### Task 3: Integrated catalog filter regression gate

**Files:**
- Modify only a Task 1 or Task 2 owned file when a failing regression proves a defect.
- Append ignored execution report under `.superpowers/sdd/2026-08-15-grouped-catalog-products/`.

**Interfaces:**
- Consumes both prior task commits.
- Produces a reviewed status-filter slice ready to enter the existing grouped-catalog release task.

- [ ] **Step 1: Run the combined catalog gate**

```powershell
npm.cmd test -- tests/unit/catalog/product-groups.test.ts tests/unit/catalog/catalog-workspace.test.tsx
npm.cmd run test:e2e -- tests/e2e/ui-v2-catalog-accounts.spec.ts tests/e2e/customer-catalog.spec.ts --workers 1
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: all checks pass with zero runtime skips or unexpected browser failures.

- [ ] **Step 2: Review implementation boundaries**

Confirm by code inspection that filter state never reaches a server action, database query mutation, URL parameter, Feishu call, order flow, or inventory update. Confirm the two workspaces use their distinct sellability predicates.

- [ ] **Step 3: Commit only if regression fixes were required**

If Step 1 found a real defect, add a RED test, make the smallest fix, rerun Step 1, and commit:

```text
fix: stabilize catalog sale status filters
```

If no fix was required, record the green evidence in the ignored report without creating an empty commit.
