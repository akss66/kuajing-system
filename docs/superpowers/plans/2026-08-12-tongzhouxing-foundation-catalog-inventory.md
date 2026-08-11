# 同舟行跨境基础、货盘与库存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付生产级高保真的“同舟行跨境”响应式 Web 平台，使超级管理员能够管理客户、店铺、SKU、价格、别名和货盘库存，使客户只能查看自己的成交价与可售库存。

**Architecture:** 使用 Next.js 模块化一体化应用和 PostgreSQL。身份、客户、商品、定价、库存和审计各自提供领域接口；页面和路由只能调用这些接口。货盘总库存与订单锁定分开保存，可售库存始终由数据库计算。

**Tech Stack:** Node.js 24、Next.js 16.3、React 19.2、TypeScript 6.0、PostgreSQL 18、Drizzle ORM、Better Auth、Zod、Tailwind CSS、shadcn/ui、TanStack Table/Query/Form、nuqs、Lucide、Vitest、Playwright、axe-core。

## Global Constraints

- 平台名称固定为“同舟行跨境”。
- 品牌原图来自 `C:\Users\AKSSINA\Desktop\同舟行logo.png`，683×656 透明 PNG；必须保持宽高比例和透明背景。
- UI 必须遵守 `PRODUCT.md`、`DESIGN.md` 和 `docs/superpowers/specs/2026-08-12-tongzhouxing-ui-design-brief.md`。
- 第一版只做浅色主题；深海青绿用于主操作，Logo 红不得用于按钮、导航选中或链接。
- 全站使用 A 的左侧导航骨架，数据工作区吸收 C 的工具栏与表格模式，运营总览吸收 B 的异常队列。
- 管理端中等偏紧凑；客户门户增加触控尺寸和局部间距。
- 360px、390px、430px 手机宽度必须真实浏览器验收，关键触控目标不小于 44px。
- 所有页面达到 WCAG 2.2 AA，并覆盖加载、空、错误、成功、禁用、权限拒绝和 API 降级状态。
- 第一阶段后台只有超级管理员角色；客户访问必须按 `customerId` 隔离。
- 所有金额使用人民币分整数保存；所有库存数量使用整数。
- 数据库时间保存 UTC；业务时区常量为 `America/Toronto`。
- PostgreSQL 是客户、商品、价格和货盘库存的唯一真实数据源。
- 不提交真实密码、第三方密钥、生产账号或消费者个人信息。
- 每个任务结束前必须通过该任务的测试、类型检查和 lint。

---

## 文件结构

```text
src/app/                         Next.js 页面和路由
src/app/(auth)/login/            登录页面
src/app/(admin)/admin/           超级管理员页面
src/app/(customer)/portal/       客户页面
src/components/ui/               shadcn/ui 基础组件
src/components/layout/           同舟行跨境应用框架和响应式导航
src/components/data-workspace/   工具栏、筛选、批量操作和数据表格
src/modules/identity/            登录和访问主体
src/modules/customers/           客户及店铺
src/modules/catalog/             商品、SKU、别名与价格
src/modules/inventory/           总库存、锁定、流水与调整
src/modules/audit/               审计事件
src/db/                          数据库客户端、schema 和迁移
src/shared/                      品牌、金额、时间和验证工具
public/brand/                    原始和派生品牌资源
tests/unit/                      纯领域单元测试
tests/integration/               PostgreSQL 集成测试
tests/e2e/                       浏览器端到端测试
```

### Task 1: 初始化应用、质量命令与品牌资源

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `vitest.integration.config.ts`
- Create: `playwright.config.ts`
- Create: `components.json`
- Create: `src/shared/brand.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/components/ui/button.tsx`
- Create: `src/components/ui/input.tsx`
- Create: `src/components/ui/table.tsx`
- Create: `src/components/ui/sidebar.tsx`
- Create: `src/components/ui/sheet.tsx`
- Create: `src/components/ui/tabs.tsx`
- Create: `src/components/ui/badge.tsx`
- Create: `src/components/ui/skeleton.tsx`
- Create: `src/components/ui/alert.tsx`
- Create: `src/components/ui/alert-dialog.tsx`
- Create: `src/components/ui/dropdown-menu.tsx`
- Create: `src/components/ui/select.tsx`
- Create: `src/components/ui/checkbox.tsx`
- Create: `src/components/ui/tooltip.tsx`
- Copy: `C:\Users\AKSSINA\Desktop\同舟行logo.png` -> `public/brand/tongzhouxing-logo.png`
- Test: `tests/unit/shared/brand.test.ts`
- Test: `tests/e2e/login-visual.spec.ts`

**Interfaces:**
- Produces: `BRAND.name`, `BRAND.logoPath`, `BUSINESS_TIME_ZONE`, approved OKLCH theme tokens and shadcn/ui primitives for all later tasks.

- [x] **Step 1: Create package metadata and commands**

Create `package.json` with these scripts and install the referenced packages so `package-lock.json` pins exact versions:

```json
{
  "name": "tongzhouxing-cross-border",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

Run:

```powershell
npm.cmd install next@16.3.0 react@19.2.8 react-dom@19.2.8 drizzle-orm postgres pg-boss zod better-auth exceljs luxon @tanstack/react-table @tanstack/react-query @tanstack/react-form nuqs lucide-react recharts
npm.cmd install -D typescript@6.0.3 @types/node @types/react @types/react-dom eslint eslint-config-next tailwindcss tsx drizzle-kit vitest @vitest/coverage-v8 @playwright/test @axe-core/playwright
```

Initialize the open component layer and add only required primitives:

```powershell
npx.cmd shadcn@4.11.0 init --base-color neutral
npx.cmd shadcn@4.11.0 add button input table sidebar sheet tabs badge skeleton alert alert-dialog dropdown-menu select checkbox tooltip
```

- [x] **Step 2: Write the failing brand test**

```ts
import { describe, expect, it } from "vitest";
import { BRAND, BUSINESS_TIME_ZONE } from "@/shared/brand";

describe("brand configuration", () => {
  it("uses the approved name, logo and Ottawa business timezone", () => {
    expect(BRAND).toEqual({
      name: "同舟行跨境",
      logoPath: "/brand/tongzhouxing-logo.png",
    });
    expect(BUSINESS_TIME_ZONE).toBe("America/Toronto");
  });
});
```

- [x] **Step 3: Run the test and verify failure**

Run: `npm.cmd test -- tests/unit/shared/brand.test.ts`

Expected: FAIL because `@/shared/brand` does not exist.

- [x] **Step 4: Implement the brand constants and root layout**

```ts
export const BRAND = {
  name: "同舟行跨境",
  logoPath: "/brand/tongzhouxing-logo.png",
} as const;

export const BUSINESS_TIME_ZONE = "America/Toronto" as const;
```

The root layout metadata title must use `BRAND.name`; its logo image must use `object-contain` so the 683×656 source is never stretched.

Configure the `@/*` path alias, Next.js ESLint rules, separate unit/integration Vitest environments, and Playwright desktop plus mobile projects. `src/app/page.tsx` must redirect authenticated users to `/admin` or `/portal` and anonymous users to `/login`.

Define these canonical light-theme roles in `src/app/globals.css`; do not create a dark theme block:

```css
:root {
  --color-primary: oklch(0.43 0.09 170);
  --color-primary-hover: oklch(0.37 0.085 170);
  --color-primary-soft: oklch(0.95 0.025 170);
  --color-background: oklch(1 0 0);
  --color-surface: oklch(0.975 0.004 180);
  --color-surface-muted: oklch(0.955 0.006 180);
  --color-ink: oklch(0.22 0.018 175);
  --color-muted: oklch(0.49 0.015 175);
  --color-border: oklch(0.89 0.008 175);
  --color-success: oklch(0.46 0.11 145);
  --color-warning: oklch(0.65 0.14 70);
  --color-danger: oklch(0.55 0.18 25);
  --color-info: oklch(0.52 0.13 245);
  --radius-control: 8px;
  --radius-surface: 10px;
  --duration-fast: 160ms;
}
```

Map shadcn semantic tokens to these roles. Body uses `Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`; numeric cells use `font-variant-numeric: tabular-nums`.

- [x] **Step 5: Copy and verify the approved PNG**

Run:

```powershell
New-Item -ItemType Directory -Force public\brand
Copy-Item -LiteralPath 'C:\Users\AKSSINA\Desktop\同舟行logo.png' -Destination 'public\brand\tongzhouxing-logo.png'
```

Verify with a test or image metadata check that the copied image is 683×656 and has an alpha channel.

Add an axe smoke test for the login surface and screenshot assertions at 1440×900 and 390×844. Verify that the primary action is deep teal and the red logo is not inherited by buttons or navigation.

- [x] **Step 6: Run quality gates**

Run: `npm.cmd test -- tests/unit/shared/brand.test.ts`

Expected: PASS.

Run: `npm.cmd typecheck`

Run: `npm.cmd lint`

Run: `npm.cmd build`

Expected: all commands exit 0.

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/app src/shared public/brand tests/unit/shared
git commit -m "feat: initialize tongzhouxing web application"
```

### Task 2: 建立 PostgreSQL、Drizzle 与测试数据库

**Files:**
- Create: `compose.yaml`
- Create: `.env.example`
- Create: `drizzle.config.ts`
- Create: `src/db/client.ts`
- Create: `tests/integration/db-health.test.ts`

**Interfaces:**
- Produces: `db`, `DbTransaction`, `withTransaction()` for all domain modules.

- [ ] **Step 1: Define local PostgreSQL and environment contract**

`compose.yaml` must expose PostgreSQL 18 only to localhost and persist data in a named volume. `.env.example` must define:

```dotenv
DATABASE_URL=postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing
TEST_DATABASE_URL=postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing_test
BETTER_AUTH_SECRET=replace-with-at-least-32-random-bytes
BETTER_AUTH_URL=http://localhost:3000
```

- [ ] **Step 2: Write the failing database health test**

```ts
import { expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

test("connects to PostgreSQL", async () => {
  const result = await db.execute(sql`select 1 as ok`);
  expect(result[0]?.ok).toBe(1);
});
```

- [ ] **Step 3: Start PostgreSQL and verify the test fails**

Run: `docker compose up -d postgres`

Run: `npm.cmd run test:integration -- tests/integration/db-health.test.ts`

Expected: FAIL because `src/db/client.ts` does not exist.

- [ ] **Step 4: Implement the database client**

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const client = postgres(connectionString, { max: 10 });
export const db = drizzle(client);
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const withTransaction = db.transaction.bind(db);
```

- [ ] **Step 5: Run integration and quality tests**

Run: `npm.cmd run test:integration -- tests/integration/db-health.test.ts`

Expected: PASS.

Run: `npm.cmd typecheck`

Run: `npm.cmd lint`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add compose.yaml .env.example drizzle.config.ts src/db tests/integration
git commit -m "feat: add PostgreSQL development foundation"
```

### Task 3: 建立账号、客户、店铺和审计 schema

**Files:**
- Create: `src/db/schema/identity.ts`
- Create: `src/db/schema/customers.ts`
- Create: `src/db/schema/audit.ts`
- Create: `src/db/schema/index.ts`
- Test: `tests/integration/schema/identity-customers.test.ts`

**Interfaces:**
- Produces: `adminUsers`, `customerUsers`, `customers`, `stores`, `auditLogs` tables.
- Produces: foreign-key rule that every store belongs to exactly one customer.

- [ ] **Step 1: Write failing schema tests**

```ts
test("a store cannot reference a missing customer", async () => {
  await expect(
    db.insert(stores).values({
      id: crypto.randomUUID(),
      customerId: crypto.randomUUID(),
      name: "不存在客户的店铺",
      status: "ACTIVE",
    }),
  ).rejects.toThrow();
});
```

Add a second test that verifies audit rows require `actorType`, `action`, `entityType`, `entityId`, `beforeJson`, `afterJson`, `reason`, and `createdAt`.

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm.cmd run test:integration -- tests/integration/schema/identity-customers.test.ts`

Expected: FAIL because the schema exports do not exist.

- [ ] **Step 3: Implement schema and enums**

Use UUID primary keys, `timestamp with time zone`, unique login identifiers, and these exact status values:

```ts
export const accountStatus = pgEnum("account_status", ["ACTIVE", "DISABLED"]);
export const actorType = pgEnum("actor_type", ["ADMIN", "CUSTOMER", "SYSTEM"]);
```

`stores.customerId` must be a non-null foreign key with `onDelete: "restrict"`. Audit records must not have update or delete repository methods.

- [ ] **Step 4: Generate and apply the migration**

Run: `npm.cmd run db:generate`

Run: `npm.cmd run db:migrate`

Expected: migration completes without manual SQL edits.

- [ ] **Step 5: Run tests**

Run: `npm.cmd run test:integration -- tests/integration/schema/identity-customers.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema drizzle tests/integration/schema
git commit -m "feat: add identity customer store and audit schema"
```

### Task 4: 实现登录主体与客户隔离

**Files:**
- Create: `src/db/schema/auth.ts`
- Create: `src/modules/identity/auth.ts`
- Create: `src/modules/identity/principal.ts`
- Create: `src/modules/identity/guards.ts`
- Create: `src/app/api/auth/[...all]/route.ts`
- Test: `tests/integration/identity/access-guards.test.ts`

**Interfaces:**
- Produces: `requireAdmin(): Promise<AdminPrincipal>`.
- Produces: `requireCustomer(): Promise<CustomerPrincipal>` where `CustomerPrincipal` contains `userId` and `customerId`.
- Produces: `assertStoreOwnership(customerId: string, storeId: string): Promise<void>`.

- [ ] **Step 1: Write failing access tests**

```ts
test("customer cannot access another customer's store", async () => {
  await expect(
    assertStoreOwnership(customerA.id, customerBStore.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN_STORE" });
});
```

Add tests that anonymous users are rejected and customer principals cannot pass `requireAdmin`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm.cmd run test:integration -- tests/integration/identity/access-guards.test.ts`

Expected: FAIL because guard functions do not exist.

- [ ] **Step 3: Configure credential authentication**

Use Better Auth with Drizzle persistence, secure HTTP-only cookies, same-site `lax`, password minimum 12 characters, and no public self-registration. Admin-created accounts are the only account provisioning path.

Define the Better Auth user, account, session and verification tables in `src/db/schema/auth.ts`, export them from the schema index, then run `npm.cmd run db:generate` and `npm.cmd run db:migrate` before executing access tests.

- [ ] **Step 4: Implement typed principals and ownership check**

```ts
export type AdminPrincipal = {
  kind: "ADMIN";
  userId: string;
};

export type CustomerPrincipal = {
  kind: "CUSTOMER";
  userId: string;
  customerId: string;
};
```

`assertStoreOwnership` must query by both `storeId` and `customerId`; it must never load by store ID and trust a browser-supplied customer ID.

- [ ] **Step 5: Run tests and quality gates**

Run: `npm.cmd run test:integration -- tests/integration/identity/access-guards.test.ts`

Expected: PASS.

Run: `npm.cmd typecheck`

Run: `npm.cmd lint`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/modules/identity src/app/api/auth tests/integration/identity
git commit -m "feat: add secure tenant-aware authentication"
```

### Task 5: 建立商品、SKU、别名和价格规则

**Files:**
- Create: `src/db/schema/catalog.ts`
- Create: `src/modules/catalog/types.ts`
- Create: `src/modules/catalog/pricing.ts`
- Create: `src/modules/catalog/repository.ts`
- Test: `tests/integration/catalog/pricing.test.ts`

**Interfaces:**
- Produces: `resolveUnitPrice(tx, input): Promise<number>` where input is `{ customerId, skuId, overrideUnitPriceFen? }`.
- Produces: `resolveStandardSku(tx, input): Promise<string | null>` where input is `{ storeId, externalSku }`.
- Produces: `listCustomerCatalog(customerId): Promise<CustomerCatalogItem[]>`.

- [ ] **Step 1: Write failing price-priority tests**

```ts
test.each([
  [{ overrideUnitPriceFen: 880, customerPriceFen: 760, defaultPriceFen: 690 }, 880],
  [{ customerPriceFen: 760, defaultPriceFen: 690 }, 760],
  [{ defaultPriceFen: 690 }, 690],
])("resolves actual unit price by approved priority", async (input, expected) => {
  expect(await resolveFixturePrice(input)).toBe(expected);
});
```

Add tests proving store-specific aliases beat global aliases and unknown aliases return `null` without guessing transformations.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm.cmd run test:integration -- tests/integration/catalog/pricing.test.ts`

Expected: FAIL because catalog schema and resolvers do not exist.

- [ ] **Step 3: Implement catalog schema**

Store prices and declaration prices as non-negative integer fen. Create unique constraints on standard `skuCode`, `(customerId, skuId)` customer price, and `(storeId, externalSku)` alias. SKU sale status values are `SELLABLE` and `NOT_SELLABLE`.

- [ ] **Step 4: Implement price and alias resolvers**

```ts
export async function resolveUnitPrice(
  tx: DbTransaction,
  input: ResolveUnitPriceInput,
): Promise<number> {
  if (input.overrideUnitPriceFen !== undefined) return input.overrideUnitPriceFen;
  const special = await findActiveCustomerPrice(tx, input.customerId, input.skuId);
  if (special !== null) return special;
  return requireDefaultSkuPrice(tx, input.skuId);
}
```

Validate the override as an integer greater than or equal to zero before entering the service.

- [ ] **Step 5: Generate migration and run tests**

Run: `npm.cmd run db:generate`

Run: `npm.cmd run db:migrate`

Run: `npm.cmd run test:integration -- tests/integration/catalog/pricing.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema/catalog.ts src/modules/catalog tests/integration/catalog drizzle
git commit -m "feat: add catalog aliases and customer pricing"
```

### Task 6: 实现货盘库存、锁定和不可变流水

**Files:**
- Create: `src/db/schema/inventory.ts`
- Create: `src/modules/inventory/types.ts`
- Create: `src/modules/inventory/service.ts`
- Create: `src/modules/inventory/queries.ts`
- Test: `tests/integration/inventory/concurrency.test.ts`

**Interfaces:**
- Produces: `getAvailableQuantity(tx, skuId): Promise<number>`.
- Produces: `reserveInventory(tx, input): Promise<InventoryReservation>`.
- Produces: `releaseReservation(tx, reservationId, reason): Promise<void>`.
- Produces: `adjustTotalInventory(tx, input): Promise<InventoryMovement>`.

- [ ] **Step 1: Write failing inventory formula and concurrency tests**

```ts
test("available equals total minus active reservations", async () => {
  await setTotalInventory(sku.id, 10);
  await db.transaction((tx) =>
    reserveInventory(tx, { skuId: sku.id, quantity: 4, referenceType: "TEST", referenceId: "a" }),
  );
  expect(await getAvailableQuantity(db, sku.id)).toBe(6);
});

test("two concurrent reservations cannot oversell the final unit", async () => {
  await setTotalInventory(sku.id, 1);
  const results = await Promise.allSettled([
    reserveOneInTransaction(sku.id, "one"),
    reserveOneInTransaction(sku.id, "two"),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await getAvailableQuantity(db, sku.id)).toBe(0);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm.cmd run test:integration -- tests/integration/inventory/concurrency.test.ts`

Expected: FAIL because inventory tables and services do not exist.

- [ ] **Step 3: Implement inventory schema**

`inventoryBalances` stores one non-negative `totalQuantity` per SKU. `inventoryReservations` stores `ACTIVE`, `RELEASED`, or `CONSUMED`. `inventoryMovements` stores `MANUAL_INCREASE`, `MANUAL_DECREASE`, `SHIPMENT`, or `REVERSAL` and always includes before, delta, after, actor and reason.

- [ ] **Step 4: Implement reservation with row locking**

```ts
export async function reserveInventory(
  tx: DbTransaction,
  input: ReserveInventoryInput,
): Promise<InventoryReservation> {
  const balance = await lockInventoryBalance(tx, input.skuId);
  const reserved = await sumActiveReservations(tx, input.skuId);
  if (balance.totalQuantity - reserved < input.quantity) {
    throw new InsufficientInventoryError(input.skuId);
  }
  return createReservation(tx, input);
}
```

`lockInventoryBalance` must issue `SELECT ... FOR UPDATE` inside the caller transaction.

- [ ] **Step 5: Implement manual adjustment and audit event**

`adjustTotalInventory` must reject zero delta, require a non-empty reason, prevent a result below active reservations, append an inventory movement and append an audit row in the same transaction.

- [ ] **Step 6: Generate migration and run tests**

Run: `npm.cmd run db:generate`

Run: `npm.cmd run db:migrate`

Run: `npm.cmd run test:integration -- tests/integration/inventory/concurrency.test.ts`

Expected: PASS, including repeated runs of the concurrency test.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema/inventory.ts src/modules/inventory tests/integration/inventory drizzle
git commit -m "feat: add auditable concurrency-safe inventory"
```

### Task 7: 构建超级管理员管理界面

**Files:**
- Create: `src/components/layout/admin-shell.tsx`
- Create: `src/components/data-workspace/data-workspace-toolbar.tsx`
- Create: `src/components/data-workspace/responsive-data-table.tsx`
- Create: `src/components/data-workspace/exception-queue.tsx`
- Create: `src/app/(admin)/admin/layout.tsx`
- Create: `src/app/(admin)/admin/page.tsx`
- Create: `src/app/(admin)/admin/customers/page.tsx`
- Create: `src/app/(admin)/admin/catalog/page.tsx`
- Create: `src/app/(admin)/admin/inventory/page.tsx`
- Test: `tests/e2e/admin-management.spec.ts`

**Interfaces:**
- Consumes: `requireAdmin`, customer/store repositories, catalog repositories, `adjustTotalInventory`.
- Produces: server actions for customer, store, SKU, price, alias and inventory management.
- Produces: reusable `AdminShell`, `DataWorkspaceToolbar`, `ResponsiveDataTable` and `ExceptionQueue` patterns.

- [ ] **Step 1: Write failing Playwright authorization test**

```ts
test("customer cannot open administrator inventory", async ({ page }) => {
  await loginAsCustomer(page);
  await page.goto("/admin/inventory");
  await expect(page).toHaveURL(/\/login|\/portal/);
});
```

Add an admin scenario that creates a customer and store, creates a SKU, assigns a customer price, adds an alias and increases inventory with a required reason.

Add `toHaveScreenshot` checks for the admin shell, data workspace and error state at 1440×900. Add axe assertions with zero serious or critical violations.

- [ ] **Step 2: Run E2E test and verify failure**

Run: `npm.cmd run test:e2e -- tests/e2e/admin-management.spec.ts`

Expected: FAIL because admin routes do not exist.

- [ ] **Step 3: Implement admin layout and navigation**

Use A“运营台账”的 approved left navigation with the brand logo and these entries: 运营总览、客户与店铺、商品与 SKU、货盘库存、订单管理、补发管理、收款与余额、报表分析、系统与同步. Unimplemented later-phase entries must render disabled labels, not dead links. At desktop width the label remains visible; at mobile width the navigation becomes a Sheet drawer.

- [ ] **Step 4: Implement customer and catalog forms**

All server actions must call `requireAdmin`, validate with Zod, invoke domain services and return field-level Chinese errors. They must not execute direct table updates in route files. Forms use consistent labels, help text, error placement, loading width and visible keyboard focus.

- [ ] **Step 5: Implement inventory page**

Display total, active reservations and available quantity separately. Use C“任务指挥栏”的 tabs, URL-synced filters, search, batch action placement and fixed key columns. Manual adjustment requires quantity, reason and optional remark; after success show movement time, operator, before and after values. Loading uses structural skeletons; empty and error states explain the next action.

Implement the B-inspired `ExceptionQueue` only on the operations overview; it must not consume horizontal space on inventory or catalog pages.

- [ ] **Step 6: Run browser and quality tests**

Run: `npm.cmd run test:e2e -- tests/e2e/admin-management.spec.ts`

Expected: PASS.

Run: `npm.cmd typecheck`

Run: `npm.cmd lint`

Run: `npm.cmd build`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(admin\) tests/e2e/admin-management.spec.ts
git commit -m "feat: add administrator catalog and inventory workspace"
```

### Task 8: 构建客户货盘与专属价格页面

**Files:**
- Create: `src/app/(customer)/portal/layout.tsx`
- Create: `src/app/(customer)/portal/page.tsx`
- Create: `src/app/(customer)/portal/catalog/page.tsx`
- Create: `src/modules/catalog/customer-catalog.ts`
- Test: `tests/e2e/customer-catalog.spec.ts`

**Interfaces:**
- Consumes: `requireCustomer`, `listCustomerCatalog(customerId)`.
- Produces: tenant-scoped customer catalog view containing SKU, image, specifications, actual price, available quantity and sale status.

- [ ] **Step 1: Write failing customer isolation test**

```ts
test("customer sees own special price and never sees another customer's price", async ({ page }) => {
  await loginAsCustomerA(page);
  await page.goto("/portal/catalog");
  await expect(page.getByText("¥7.60")).toBeVisible();
  await expect(page.getByText("¥6.20")).toHaveCount(0);
});
```

Add a test that total inventory 10 with 4 active reservations displays available quantity 6, and total inventory 4 with 4 reservations displays `不可售`.

Run the same customer path at 360×800, 390×844 and 430×932. Assert that the navigation opens as a drawer, primary touch targets are at least 44px, no page-level horizontal overflow exists, and SKU details remain readable without reducing body text below 14px.

- [ ] **Step 2: Run E2E test and verify failure**

Run: `npm.cmd run test:e2e -- tests/e2e/customer-catalog.spec.ts`

Expected: FAIL because customer portal routes do not exist.

- [ ] **Step 3: Implement customer catalog query**

`listCustomerCatalog` must derive price through `resolveUnitPrice`, derive available quantity through inventory queries, exclude disabled SKUs and never return default or other-customer price records as extra fields.

- [ ] **Step 4: Implement responsive customer portal**

Use the approved navigation: 工作台、货盘选品、上传 TEMU 订单、我的订单、待付款、余额与流水、店铺数据. Later-phase entries render disabled with “即将开放”. The catalog supports SKU/name search and displays exact available quantity. Desktop uses a compact table; mobile uses grouped SKU rows with image, SKU, price, available quantity and sale status, plus a full-width filter drawer.

- [ ] **Step 5: Run tests and build**

Run: `npm.cmd run test:e2e -- tests/e2e/customer-catalog.spec.ts`

Expected: PASS on desktop and mobile Playwright projects.

Run axe checks and visual screenshots for 1440×900, 390×844 and 360×800.

Expected: no serious/critical accessibility violations and no unintended screenshot difference.

Run: `npm.cmd test`

Run: `npm.cmd run test:integration`

Run: `npm.cmd typecheck`

Run: `npm.cmd lint`

Run: `npm.cmd build`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(customer\) src/modules/catalog/customer-catalog.ts tests/e2e/customer-catalog.spec.ts
git commit -m "feat: add tenant-scoped customer cargo catalog"
```

### Task 9: 完成第一阶段审计、种子数据和验收

**Files:**
- Create: `src/db/seed.ts`
- Create: `src/modules/audit/query.ts`
- Create: `src/app/(admin)/admin/system/audit/page.tsx`
- Create: `docs/operations/local-development.md`
- Test: `tests/e2e/phase-one-acceptance.spec.ts`

**Interfaces:**
- Consumes: all Phase 1 domain services.
- Produces: reproducible non-sensitive demo environment and Phase 1 acceptance evidence.

- [ ] **Step 1: Write failing phase acceptance test**

The test must perform this exact flow: admin logs in, creates customer and store, creates SKU `TZX-DEMO-001` with default price 690 fen, sets customer price 760 fen, maps external SKU `TEMU-DEMO-RED`, adds total inventory 10 with reason `首批测试库存`, logs in as the customer, and verifies price `¥7.60` and available quantity `10`.

The acceptance suite must also capture approved baseline screenshots for login, admin overview, admin inventory, customer catalog desktop and customer catalog mobile. Review screenshots for text clipping, incorrect status colors, red primary controls, nested card grids and excessive whitespace before accepting updates.

- [ ] **Step 2: Run the acceptance test and capture failure**

Run: `npm.cmd run test:e2e -- tests/e2e/phase-one-acceptance.spec.ts`

Expected: FAIL until seed helpers and audit page exist.

- [ ] **Step 3: Implement deterministic seed data**

`src/db/seed.ts` must create only fictional data, hash fixed local-only passwords, be idempotent by stable email/SKU keys and refuse to run when `NODE_ENV=production`.

- [ ] **Step 4: Implement read-only audit page**

The page requires admin access and filters by actor, action, entity and date. It can display audit JSON differences but offers no update or delete action.

- [ ] **Step 5: Write local operations documentation**

Document exact commands for environment creation, PostgreSQL startup, migration, seed, Web startup, all test suites and database reset. Include the rule that `.env` is never committed.

- [ ] **Step 6: Run the full Phase 1 verification**

Run:

```powershell
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd typecheck
npm.cmd lint
npm.cmd build
git status --short
```

Expected: all commands exit 0; `git status --short` shows only the intended Phase 1 files before commit.

- [ ] **Step 7: Commit**

```bash
git add src/db/seed.ts src/modules/audit src/app/\(admin\)/admin/system docs/operations tests/e2e/phase-one-acceptance.spec.ts
git commit -m "test: complete phase one platform acceptance"
```

## 第一阶段完成定义

- “同舟行跨境”名称和正式 Logo 正确显示，Logo 未拉伸。
- 超级管理员可以管理客户、店铺、SKU、别名、默认价、客户价和库存。
- 客户只能看到自己名下数据和自己的实际价格。
- 可售库存始终等于总库存减有效锁定。
- 并发库存测试证明不会超卖或出现负库存。
- 库存调整、客户、店铺、商品和价格变化有审计记录。
- 全部单元、集成、E2E、类型检查、lint 和构建通过。
- 浏览器分别以桌面和手机尺寸验收管理员与客户页面。
- 页面视觉符合 A 骨架 + C 数据工作区 + B 总览异常队列的已批准组合。
- 第一版只有浅色主题；主操作使用深海青绿，Logo 红未扩散为操作色。
- 360px、390px、430px 无页面级横向溢出，关键触控目标不小于 44px。
- axe 检查无 serious/critical 问题，键盘焦点和减少动画模式有效。
- 加载、空、错误、成功、禁用和 API 降级状态均有真实组件与自动化覆盖。
