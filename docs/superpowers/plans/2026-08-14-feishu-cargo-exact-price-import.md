# Feishu Cargo Exact Price Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the approved Feishu cargo source into PostgreSQL without writing Feishu, preserving three-decimal RMB unit prices and rounding each final order line total to fen.

**Architecture:** Add an integer milli-yuan price alongside the existing rounded-fen compatibility fields. Milli-yuan is canonical for SKU and order-line pricing; line totals remain integer fen and use deterministic half-up rounding after multiplying by quantity. The Feishu parser handles only the explicitly approved legacy formats, emits warnings for every normalization, skips only a terminal SKU-only draft, and keeps all remote Feishu writes permanently disabled.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM, PostgreSQL, Vitest, Docker Compose.

## Global Constraints

- Never call any Feishu write API or configure a target spreadsheet.
- `FEISHU_CARGO_WRITES_ENABLED` remains hard-coded to `false` in production Compose.
- Do not write product, SKU, inventory, or catalog-asset records until a fresh production preflight is ready.
- Prices `0.325` and `1.366` must be preserved exactly as 325 and 1366 milli-yuan.
- Order line total in fen is `floor((quantity * unitPriceMilliYuan + 5) / 10)` for non-negative prices.
- `0.58/6PCS` and `0.35/5PCS` are package-SKU prices of 580 and 350 milli-yuan.
- Approved weights: `50g/包` → 50g, `9g*4` → 36g, `6g*3` → 18g, `12.5g` → 13g.
- A source product-link cell containing only `0` becomes `null` with a visible warning.
- A terminal SKU-only draft such as `TZX-077` is excluded with a visible warning; an incomplete middle row remains blocking.

---

### Task 1: Canonical milli-yuan money model

**Files:**
- Create: `src/modules/catalog/unit-price.ts`
- Create: `drizzle/0016_exact_unit_price.sql`
- Modify: `src/db/schema/catalog.ts`
- Modify: `src/db/schema/orders.ts`
- Modify: `drizzle/meta/_journal.json`
- Test: `tests/unit/catalog/unit-price.test.ts`
- Test: `tests/integration/schema/exact-unit-price.test.ts`

**Interfaces:**
- Produces: `fenToMilliYuan(fen: number): number`, `roundMilliYuanToFen(milliYuan: number): number`, and `calculateLineAmountFen(quantity: number, unitPriceMilliYuan: number): number`.
- Produces database columns `skus.default_unit_price_milli_yuan`, `customer_sku_prices.unit_price_milli_yuan`, and `order_lines.unit_price_milli_yuan`.

- [ ] **Step 1: Write failing unit and PostgreSQL schema tests**

```ts
expect(roundMilliYuanToFen(325)).toBe(33);
expect(calculateLineAmountFen(2, 325)).toBe(65);
expect(calculateLineAmountFen(3, 325)).toBe(98);
```

The schema test inserts `unitPriceMilliYuan=325`, `unitPriceFen=33`, `quantity=3`, `lineAmountFen=98`, then proves a mismatched amount is rejected.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- tests/unit/catalog/unit-price.test.ts`

Run: `npm.cmd run test:integration -- tests/integration/schema/exact-unit-price.test.ts`

Expected: missing helper/columns and old exact-multiplication constraint failures.

- [ ] **Step 3: Implement helpers, schema, and forward migration**

Use safe-integer guards before multiplication. Migration `0016` adds nullable columns, backfills each from its fen column times ten, sets `NOT NULL`, adds non-negative and rounded-fen consistency checks, and replaces `order_lines_amount_matches_quantity` with the milli-yuan rounding expression using `bigint` multiplication.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: preserve milli-yuan unit prices"
```

### Task 2: Use canonical precision in pricing and order creation

**Files:**
- Modify: `src/modules/catalog/types.ts`
- Modify: `src/modules/catalog/pricing.ts`
- Modify: `src/modules/catalog/actions.ts`
- Modify: `src/modules/orders/submission.ts`
- Modify: `src/modules/bulk-order/submission-service.ts`
- Modify: `src/modules/bulk-order/workspace-query.ts`
- Modify: `src/modules/catalog/customer-catalog.ts`
- Modify: `src/db/seed.ts`
- Test: `tests/unit/catalog/pricing.test.ts`
- Test: `tests/integration/orders/submission.test.ts`
- Test: `tests/integration/bulk-order/submission.test.ts`

**Interfaces:**
- `resolveUnitPrice` returns `{ unitPriceFen, unitPriceMilliYuan }`.
- Every inserted order line stores both values and calls `calculateLineAmountFen`.
- Existing admin/customer overrides supplied in fen are stored as `fen * 10`, so existing two-decimal workflows remain compatible.

- [ ] **Step 1: Add RED tests for quantity 2 and 3 at ¥0.325**

Assert line totals 65 and 98 fen, order totals equal the sum of rounded line totals, and stored order lines retain `unitPriceMilliYuan=325`.

- [ ] **Step 2: Run focused tests and verify RED**

- [ ] **Step 3: Implement minimal pricing and submission changes**

Never round the unit price before multiplying. Use `safeAdd`/safe-integer checks for every accumulated total.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: settle exact unit prices by order line"
```

### Task 3: Normalize only approved Feishu legacy values

**Files:**
- Modify: `src/modules/feishu/cargo-types.ts`
- Modify: `src/modules/feishu/cargo-parser.ts`
- Modify: `src/modules/feishu/migration-service.ts`
- Modify: `src/modules/feishu/queries.ts`
- Modify: `src/modules/feishu/cargo-sync.ts`
- Modify: `src/components/feishu/cargo-preflight-table.tsx`
- Test: `tests/unit/feishu/cargo-parser.test.ts`
- Test: `tests/integration/feishu/migration-service.test.ts`

**Interfaces:**
- Parsed and normalized cargo rows include `defaultUnitPriceMilliYuan` and retain rounded `defaultUnitPriceFen` for compatibility.
- Every approved conversion emits a `WARNING`; unknown decorated prices or weights remain `BLOCKING`.

- [ ] **Step 1: Add RED parser tests for every approved raw value**

```ts
expect(parsePrice("0.325")).toEqual({ milliYuan: 325, fen: 33 });
expect(parsePrice("0.58/6PCS")).toEqual({ milliYuan: 580, fen: 58 });
expect(parseWeight("9g*4")).toBe(36);
expect(parseWeight("12.5g")).toBe(13);
```

Also assert link `0` maps to `null` only for that sentinel and `TZX-077` is the sole terminal-draft warning in the production shape.

- [ ] **Step 2: Run parser and migration tests and verify RED**

- [ ] **Step 3: Implement strict parsers and import mapping**

Do not use loose numeric-prefix parsing. Match the approved full-string patterns so malformed or novel source values cannot silently normalize.

- [ ] **Step 4: Run focused tests and verify GREEN**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: normalize approved Feishu cargo values"
```

### Task 4: Exact-price UI, release verification, and guarded import

**Files:**
- Modify: `src/components/catalog/catalog-results.tsx`
- Modify: `src/components/catalog/customer-catalog-workspace.tsx`
- Modify: `src/app/(admin)/admin/catalog/page.tsx`
- Modify: `src/app/(admin)/admin/orders/[orderId]/page.tsx`
- Modify: `src/app/(customer)/portal/orders/[orderId]/page.tsx`
- Modify: `docs/operations/feishu-cargo-migration.md`
- Test: relevant catalog/order unit tests and production read-only preflight evidence.

**Interfaces:**
- `formatMilliYuan` displays two decimals for exact-cent values and three decimals when the third digit is non-zero.
- Production import remains a one-shot super-admin operation guarded by `FEISHU_CARGO_IMPORT_ENABLED=true`; Feishu remote writes remain impossible.

- [ ] **Step 1: Add RED display tests for ¥0.325 and ¥1.366**
- [ ] **Step 2: Implement exact-price display without page-level font/style overrides**
- [ ] **Step 3: Run unit, full integration, typecheck, lint, build, `npm audit`, and `git diff --check`**
- [ ] **Step 4: Deploy with both import and write gates false, then run real read-only preflight**
- [ ] **Step 5: Require preflight READY with 76 products, 140 SKU rows, 140 images, source revision evidence, and only approved warnings**
- [ ] **Step 6: Verify business tables remain empty, take a PostgreSQL backup, enable only the database-import gate, and confirm the exact ready run once**
- [ ] **Step 7: Immediately set the database-import gate back to false and recreate Web/Worker**
- [ ] **Step 8: Verify product/SKU/inventory/assets/audit counts, exact prices, public catalog images, source revision unchanged, and zero Feishu target calls**
- [ ] **Step 9: Commit documentation/evidence**

```bash
git commit -m "docs: record guarded Feishu cargo import"
```

## Self-Review

- Spec coverage: exact prices, approved legacy formats, tail draft exclusion, nullable URL, order rounding, UI display, read-only Feishu boundary, backup, one-shot import, and post-import verification are all assigned.
- Placeholder scan: no TBD/TODO/follow-up placeholders.
- Type consistency: canonical field name is `unitPriceMilliYuan`; compatibility fields retain the `*Fen` names.
