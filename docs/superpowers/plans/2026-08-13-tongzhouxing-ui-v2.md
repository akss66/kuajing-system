# Tongzhouxing UI V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把管理员端和客户端从均质化开发后台升级为任务导向、专业、紧凑、完整响应式的同舟行跨境商家工作台，同时保持现有业务状态机、权限和路由语义不变。

**Architecture:** 先统一全宽顶栏、分组导航和共享管理交互，再将账号、客户、驾驶舱、资源列表、交易页面、客户流程和系统页面按五类页面模式逐批迁移。Server Components 继续负责鉴权和读取真实数据库；需要筛选、标签、抽屉和局部交互的区域进入窄边界 Client Components，所有写操作继续复用现有 Server Actions 和审计规则。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 6、Tailwind CSS 4、Radix/shadcn、Drizzle/PostgreSQL、Vitest/Testing Library、Playwright、axe-core、Recharts。

## Global Constraints

- 规范来源：`docs/superpowers/specs/2026-08-13-tongzhouxing-ui-v2-design.md`。
- 第一阶段只做浅色主题；禁止新增深色主题。
- 全站字体必须继续使用本地 `Geist Variable + Noto Sans SC Variable` 字体令牌，禁止页面单独覆盖 `font-family`。
- 深海青绿是唯一主操作色；Logo 红只属于品牌标志，不作为按钮、链接或导航选中色。
- 顶栏必须全宽 56px；桌面左侧品牌/导航宽 224px；顶栏底线与侧栏边线连续对齐。
- 保留现有路由语义、权限边界、一个客户一个客户登录账号、客户数据隔离、审计原因和所有业务状态机。
- 只使用真实数据库数据；禁止以硬编码统计或演示数据伪造 UI 指标。
- 列表页默认不得展开编辑、重置、启停或创建表单。
- 每个页面标题区最多一个主操作；危险操作必须单独分区、展示后果、二次确认并填写原因。
- 桌面管理页面保持中等偏紧凑；移动关键触控目标不小于 44px，正文不小于 14px。
- 验收宽度为 1440px、1920px、430px、390px、360px；页面横向溢出差值必须小于等于 1px。
- axe serious/critical 必须为 0；不得出现 hydration、page error 或未处理 console error。
- 极风和飞书授权接入不在本计划内；相关入口只展示真实的停用/未配置状态。
- 每个行为变更严格遵循 RED → GREEN；未观察到正确失败的测试不算 TDD 证据。
- 子任务不得提交 `.agents/`、`.claude/`、`.codex/`、`.codex-temp/`、`.grok/`、`.impeccable/` 或测试截图临时产物。

---

## File Structure and Ownership

### Shared shell and navigation

- `src/components/layout/merchant-shell-frame.tsx`: 全宽顶栏、桌面侧栏和内容画布的唯一几何骨架。
- `src/components/layout/merchant-topbar.tsx`: 品牌、移动导航、通知和账号菜单。
- `src/components/layout/navigation-section.tsx`: 可折叠导航分组与唯一 active 状态。
- `src/components/layout/admin-shell.tsx`: 管理员导航配置与权限过滤。
- `src/components/layout/customer-shell.tsx`: 客户任务导航配置。

### Shared management interactions

- `src/components/management/entity-drawer.tsx`: 响应式右侧/全屏实体抽屉。
- `src/components/management/drawer-section.tsx`: 抽屉中的资料、安全和危险分区。
- `src/components/management/danger-zone.tsx`: 危险操作视觉和语义容器。
- `src/components/management/actionable-empty-state.tsx`: 初始空、筛选空、异常空。

### Domain workspaces

- `src/components/accounts/account-management-workspace.tsx`: 账号标签、筛选、列表和抽屉。
- `src/components/customers/customer-list-workspace.tsx`: 客户筛选、列表和创建抽屉。
- `src/components/customers/customer-detail-workspace.tsx`: 客户详情标签、资料和关联数据。
- `src/components/customers/store-management-drawer.tsx`: 店铺创建、编辑和危险操作。
- 后续各任务只在所属 domain 下新增窄边界组件，禁止把全部页面逻辑再次堆回 `page.tsx`。

---

### Task 1: Rebuild the Unified Merchant Shell and Grouped Navigation

**Files:**
- Create: `src/components/layout/merchant-shell-frame.tsx`
- Create: `src/components/layout/navigation-section.tsx`
- Modify: `src/components/layout/merchant-topbar.tsx`
- Modify: `src/components/layout/admin-shell.tsx`
- Modify: `src/components/layout/customer-shell.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/unit/ui/merchant-shell.test.tsx`
- Create: `tests/e2e/ui-v2-shell.spec.ts`

**Interfaces:**
- Produces `MerchantShellFrame({ audience, navigation, topbar, children }: MerchantShellFrameProps)` with `data-merchant-shell`, `data-merchant-brand`, `data-merchant-sidebar`, `data-merchant-content` markers.
- Produces `NavigationSection({ id, label, items, defaultOpen, activePath, mobile }: NavigationSectionProps)`; each `NavigationItem` is `{ href: string; icon: LucideIcon; label: string; exact?: boolean }`.
- `MerchantTopbar` consumes brand content from the shared frame and exposes only mobile menu, notification and account controls.

- [ ] **Step 1: Write failing shell unit tests**

Add tests that render both shells and assert:

```tsx
expect(screen.getByTestId("merchant-shell")).toHaveAttribute("data-shell-version", "v2");
expect(screen.getByText("客户与货品")).toBeVisible();
expect(screen.getByText("订单履约")).toBeVisible();
expect(screen.getByText("资金与数据")).toBeVisible();
expect(screen.getByText("系统管理")).toBeVisible();
expect(screen.queryByText("店铺数据")).not.toBeInTheDocument();
expect(screen.queryByText("帮助")).not.toBeInTheDocument();
expect(screen.queryByText("消息")).not.toBeInTheDocument();
```

- [ ] **Step 2: Write failing geometry E2E**

In `ui-v2-shell.spec.ts`, log in as super admin and customer, then assert desktop geometry:

```ts
const topbar = await page.locator("[data-merchant-topbar]").boundingBox();
const brand = await page.locator("[data-merchant-brand]").boundingBox();
const sidebar = await page.locator("[data-merchant-sidebar]").boundingBox();
expect(topbar).toMatchObject({ x: 0, y: 0, height: 56 });
expect(brand).toMatchObject({ x: 0, y: 0, width: 224, height: 56 });
expect(sidebar).toMatchObject({ x: 0, y: 56, width: 224 });
```

Also assert one `[aria-current="page"]`, grouped navigation, no page overflow, and mobile drawer accessibility at 390px.

- [ ] **Step 3: Run RED**

Run:

```powershell
npm.cmd test -- tests/unit/ui/merchant-shell.test.tsx
npm.cmd run test:e2e -- tests/e2e/ui-v2-shell.spec.ts --project=desktop-chromium --workers=1
```

Expected: failures for missing V2 shell markers, navigation groups, and 56px full-width geometry.

- [ ] **Step 4: Implement the shared geometry and navigation**

Use one fixed full-width 56px header; place the 224px brand region inside it; start the desktop sidebar at `top: 56px`; remove the lower identity card; remove unavailable help/message actions; add navigation groups and persisted collapsed state. Keep permission filtering for `账号管理` in `AdminShell`.

- [ ] **Step 5: Run GREEN and regression checks**

Run focused unit/E2E, then:

```powershell
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

- [ ] **Step 6: Commit**

```powershell
git add src/components/layout src/app/globals.css tests/unit/ui/merchant-shell.test.tsx tests/e2e/ui-v2-shell.spec.ts
git commit -m "feat: unify merchant shell and navigation"
```

---

### Task 2: Add Shared Drawers, Danger Zones, and Actionable Empty States

**Files:**
- Create: `src/components/management/entity-drawer.tsx`
- Create: `src/components/management/drawer-section.tsx`
- Create: `src/components/management/danger-zone.tsx`
- Create: `src/components/management/actionable-empty-state.tsx`
- Modify: `src/components/ui/sheet.tsx`
- Create: `tests/unit/ui/management-primitives.test.tsx`

**Interfaces:**
- `EntityDrawer` props: `{ trigger: ReactNode; title: ReactNode; description?: ReactNode; children: ReactNode; size?: "md" | "lg"; testId?: string }`.
- `DrawerSection` props: `{ title: string; description?: string; children: ReactNode }`.
- `DangerZone` props: `{ title?: string; description: string; children: ReactNode }`.
- `ActionableEmptyState` props: `{ kind: "initial" | "filtered" | "error"; title: string; description: string; action?: ReactNode }`.

- [ ] **Step 1: Write failing accessibility and behavior tests**

Cover trigger-open-close focus restoration, correct dialog title/description, `sm:max-w-[640px]` large size, mobile full-width behavior, danger-zone semantics, and empty-state action visibility.

- [ ] **Step 2: Run RED**

```powershell
npm.cmd test -- tests/unit/ui/management-primitives.test.tsx
```

Expected: module-not-found failures for all new components.

- [ ] **Step 3: Implement minimal shared primitives**

Build on existing Radix `Sheet`; change the close-button screen-reader copy from `Close` to `关闭`; keep focus management delegated to Radix; do not add a generic form abstraction or business-domain props.

- [ ] **Step 4: Run GREEN**

Run focused test, typecheck, lint, and diff check.

- [ ] **Step 5: Commit**

```powershell
git add src/components/management src/components/ui/sheet.tsx tests/unit/ui/management-primitives.test.tsx
git commit -m "feat: add management drawer primitives"
```

---

### Task 3: Redesign Account Management as a Compact Workspace

**Files:**
- Create: `src/components/accounts/account-management-workspace.tsx`
- Modify: `src/app/(admin)/admin/accounts/page.tsx`
- Modify: `tests/unit/accounts/account-management.test.tsx`
- Modify: `tests/e2e/admin-management.spec.ts`

**Interfaces:**
- `AccountManagementWorkspace({ accounts }: { accounts: ManagedAccountSummary[] })` owns tabs, search, status filters, creation drawer, account details drawer and mobile cards.
- Existing actions remain unchanged: `createAdminAccountAction`, `updateManagedAccountAction`, `resetManagedAccountPasswordAction`, `setManagedAccountStatusAction`.
- Existing `listManagedAccounts()` remains the source of truth.

- [ ] **Step 1: Replace current tests with V2 behavior assertions**

Tests must assert:

```tsx
expect(screen.getByRole("button", { name: "新建管理员" })).toBeVisible();
expect(screen.getByRole("tab", { name: /管理员账号/ })).toBeVisible();
expect(screen.getByRole("searchbox", { name: "搜索账号" })).toBeVisible();
expect(screen.queryByRole("button", { name: "保存资料" })).not.toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "查看 Operations Admin" }));
expect(screen.getByRole("dialog", { name: "Operations Admin" })).toBeVisible();
expect(screen.getByRole("button", { name: "保存资料" })).toBeVisible();
```

For the bootstrap super admin drawer, assert a lock/protected label and no reset/status form. For a customer account, assert the customer-detail link and store count.

- [ ] **Step 2: Run RED**

Run the account unit file and targeted admin E2E. Expected: old page exposes row forms immediately and lacks drawer/search behavior.

- [ ] **Step 3: Implement the compact workspace**

Render one summary row per account. Add tabs with counts, search by name/email/customer, role/status controls, creation drawer, and per-account drawer. Put basic information, password reset and status actions into separate `DrawerSection`s; wrap enable/disable in `DangerZone`. The super admin remains read-only and protected.

- [ ] **Step 4: Update E2E to use visible drawers**

Keep all existing governance assertions: create ordinary admin only, update identity, reset password, session revocation on disable, login denial, restore, and ordinary-admin route denial. Open the correct drawer before locating forms; do not weaken any backend assertion.

- [ ] **Step 5: Run GREEN**

Run account unit, desktop and mobile `admin-management.spec.ts`, full unit suite, typecheck, lint, and diff check.

- [ ] **Step 6: Commit**

```powershell
git add src/components/accounts 'src/app/(admin)/admin/accounts/page.tsx' tests/unit/accounts/account-management.test.tsx tests/e2e/admin-management.spec.ts
git commit -m "feat: redesign account management workspace"
```

---

### Task 4: Redesign the Customer List and Creation Flow

**Files:**
- Create: `src/components/customers/customer-list-workspace.tsx`
- Modify: `src/app/(admin)/admin/customers/page.tsx`
- Modify: `src/modules/customers/queries.ts`
- Modify: `tests/unit/customers/customer-management-pages.test.tsx`
- Create: `tests/integration/customers/management-queries.test.ts`
- Modify: `tests/e2e/admin-management.spec.ts`

**Interfaces:**
- Extend `CustomerManagementListRow` with `accountEmail`, `balanceFen`, `pendingPaymentFen`, `recentOrderCount`, `exceptionOrderCount`.
- `recentOrderCount` means orders with `submitted_at >= now() - interval '30 days'`.
- `pendingPaymentFen` sums `PENDING_PAYMENT` fulfillment orders.
- `exceptionOrderCount` counts `FULFILLMENT_EXCEPTION` orders.
- `CustomerListWorkspace({ rows })` owns client-side search/status filters and the new-customer drawer.

- [ ] **Step 1: Write a real PostgreSQL RED query test**

Seed two customers with different wallets, stores and order states. Assert the list query returns exact `balanceFen`, `pendingPaymentFen`, 30-day order count and exception count without row multiplication.

- [ ] **Step 2: Write page RED tests**

Assert the list page has a `新建客户` button, no visible customer-creation inputs before opening the drawer, columns/cards for account, stores, balance, pending payment, recent orders and exception status, and an actionable initial/filtered empty state.

- [ ] **Step 3: Run RED**

Run both new integration and customer unit tests. Expected: missing fields and permanently visible creation form.

- [ ] **Step 4: Implement query aggregation and workspace**

Use grouped SQL/CTEs or isolated aggregates to avoid wallet/order/store cross-product errors. Preserve one row per customer. Move `createCustomerWithStoreAction` into `EntityDrawer`; keep all six required fields and audit reason. Use a compact desktop table and mobile summary cards.

- [ ] **Step 5: Update E2E creation flow**

Open `新建客户`, complete the form in the drawer, preserve the existing database and auth assertions, and verify the new customer appears in the list without horizontal overflow.

- [ ] **Step 6: Run GREEN and commit**

Run focused integration/unit/E2E on desktop and mobile, then typecheck/lint/diff, and commit:

```powershell
git commit -m "feat: redesign customer management list"
```

---

### Task 5: Rebuild Customer Detail and Store Management

**Files:**
- Create: `src/components/customers/customer-detail-workspace.tsx`
- Create: `src/components/customers/store-management-drawer.tsx`
- Modify: `src/app/(admin)/admin/customers/[customerId]/page.tsx`
- Modify: `src/modules/customers/queries.ts`
- Modify: `tests/unit/customers/customer-management-pages.test.tsx`
- Modify: `tests/integration/customers/management-queries.test.ts`
- Modify: `tests/e2e/admin-management.spec.ts`

**Interfaces:**
- Extend `getCustomerManagementDetail(customerId)` to return `{ customer, account, stores, summary, recentOrders, recentTransactions }`.
- `summary` is `{ balanceFen, pendingPaymentFen, recentOrderCount, storeCount }`.
- `recentOrders` returns the latest 20 orders with order id/number, store name, status, amount and submitted time.
- `recentTransactions` returns the latest 20 wallet transactions with type, delta, after-balance, reason and created time.
- `CustomerDetailWorkspace` exposes tabs `概览`, `店铺`, `订单与补发`, `资金记录`.

- [ ] **Step 1: Write RED query and page tests**

Assert exact summary aggregation, maximum 20 recent rows, and ownership isolation. Page tests must assert customer data is read-only by default, `编辑客户` opens a drawer, account summary links to `/admin/accounts?customerId=<id>`, `新增店铺` opens a drawer, and store edit/status controls are absent until its drawer opens.

- [ ] **Step 2: Run RED**

Expected: old detail returns only customer/account/stores and exposes every edit form by default.

- [ ] **Step 3: Implement the detail workspace**

Use business summary values instead of status/contact KPI cards. Keep profile summary read-only. Place update form in an edit drawer, customer status action in a danger zone, store list in a compact table/card layout, and each store’s update/status forms in `StoreManagementDrawer`. Show real recent orders and transactions in their tabs with localized states and currency.

- [ ] **Step 4: Preserve governance E2E**

Update, add store, edit store, disable/restore store and disable/restore customer through drawers. Retain all existing database, login and session-revocation assertions.

- [ ] **Step 5: Run GREEN and commit**

Run focused unit/integration/E2E desktop/mobile, full unit, typecheck, lint and diff check. Commit:

```powershell
git commit -m "feat: rebuild customer and store details"
```

---

### Task 6: Replace Asset Counters with Admin and Customer Operations Dashboards

**Files:**
- Create: `src/modules/dashboard/admin-queries.ts`
- Create: `src/modules/dashboard/customer-queries.ts`
- Create: `src/components/dashboard/admin-operations-dashboard.tsx`
- Create: `src/components/dashboard/customer-task-dashboard.tsx`
- Create: `src/components/dashboard/seven-day-trend.tsx`
- Modify: `src/app/(admin)/admin/page.tsx`
- Modify: `src/app/(customer)/portal/page.tsx`
- Create: `tests/integration/dashboard/dashboard-queries.test.ts`
- Create: `tests/unit/ui/operations-dashboard.test.tsx`
- Modify: `tests/e2e/merchant-center-visual.spec.ts`

**Interfaces:**
- `getAdminOperationsDashboard(now?: Date)` returns today order count, today GMV fen, shipped count, pending-fulfillment count, pending-payment-review count, critical stock count, fulfillment-exception count, import-exception count, seven-day order/GMV series and top SKU/store rows.
- Toronto business-day boundaries must be computed by existing date utilities or Luxon with `America/Toronto`, never local server time.
- `getCustomerTaskDashboard(customerId, now?: Date)` returns unfinished draft count, pending-payment count/fen, payment-reported count, fulfillment-exception count, active stores, wallet balance/holds, recent store summaries and primary continuation target.

- [ ] **Step 1: Write deterministic real-DB RED tests**

Use a fixed `now` and records around Toronto midnight to prove day boundaries, customer isolation and exact sums.

- [ ] **Step 2: Write dashboard component RED tests**

Assert admin sections `今日经营`, `待办与预警`, `近 7 天趋势`, `快捷处理`; assert customer sections `继续处理`, `快捷拿货`, `店铺摘要`, `资金摘要`. Assert no hard-coded `390 px`, `2 种`, or asset-only placeholder metrics.

- [ ] **Step 3: Implement real queries and dashboards**

Use server-fetched data and a narrow Recharts client component for trends. When no trend data exists, render an actionable empty state rather than a fake flat chart. Prioritize outstanding tasks above static summaries on mobile.

- [ ] **Step 4: Run GREEN and visual checks**

Run query/component tests and desktop/mobile visual tests for `/admin` and `/portal`; inspect screenshots for first-viewport task priority.

- [ ] **Step 5: Commit**

```powershell
git commit -m "feat: add operations and customer task dashboards"
```

---

### Task 7: Differentiate Catalog and Inventory Workspaces

**Files:**
- Create: `src/components/catalog/catalog-workspace.tsx`
- Create: `src/components/inventory/inventory-workspace.tsx`
- Modify: `src/app/(admin)/admin/catalog/page.tsx`
- Modify: `src/app/(admin)/admin/inventory/page.tsx`
- Modify: `src/app/(customer)/portal/catalog/page.tsx`
- Modify: `tests/e2e/customer-catalog.spec.ts`
- Modify: `tests/e2e/admin-management.spec.ts`
- Modify: `tests/e2e/merchant-center-visual.spec.ts`

**Interfaces:**
- Catalog pages use search-first resource lists and creation/edit drawers.
- Inventory uses health summary, low-stock queue, available/locked/total columns and movement context; editing inventory is not permanently visible.
- Customer catalog preserves customer-specific actual price and stock isolation.

- [ ] **Step 1: Add RED component/E2E assertions**

Assert create/edit forms are hidden until drawers open, search is visible in the first mobile viewport, inventory has localized total/locked/available headers and no horizontal overflow at 360/390/430.

- [ ] **Step 2: Run RED**

Expected: current pages still use generic metric-strip/table structure and at least one permanent management form.

- [ ] **Step 3: Implement distinct workspaces**

Keep existing queries/actions and business behavior. Move mutation forms into drawers, give inventory risk-first hierarchy, and keep customer catalog task-first. Do not add cart/business behavior in this task.

- [ ] **Step 4: Run GREEN and commit**

Run catalog/inventory unit/E2E visual/mobile gates, typecheck/lint/diff, then commit:

```powershell
git commit -m "feat: differentiate catalog and inventory workspaces"
```

---

### Task 8: Reorganize Orders, Settlement, Wallet, and Detail Timelines

**Files:**
- Create: `src/components/orders/order-filter-bar.tsx`
- Create: `src/components/orders/order-status-timeline.tsx`
- Create: `src/components/settlement/settlement-workspace.tsx`
- Modify: `src/app/(admin)/admin/orders/page.tsx`
- Modify: `src/app/(admin)/admin/orders/[orderId]/page.tsx`
- Modify: `src/app/(admin)/admin/settlement/page.tsx`
- Modify: `src/app/(admin)/admin/settlement-batches/page.tsx`
- Modify: `src/app/(admin)/admin/settlement-batches/[settlementId]/page.tsx`
- Modify: `src/app/(customer)/portal/orders/page.tsx`
- Modify: `src/app/(customer)/portal/orders/[orderId]/page.tsx`
- Modify: `src/app/(customer)/portal/settlements/[settlementId]/page.tsx`
- Modify: `src/app/(customer)/portal/wallet/page.tsx`
- Modify: `tests/e2e/phase-two-payment.spec.ts`
- Modify: `tests/e2e/phase-three-fulfillment.spec.ts`
- Modify: `tests/e2e/multi-store-bulk-order.spec.ts`

**Interfaces:**
- `OrderFilterBar` shows at most four common filters and moves dates/secondary fields to a responsive filter drawer; active filters are removable chips backed by URL params.
- `OrderStatusTimeline` maps existing payment, fulfillment, replacement and cancellation states into localized stages without changing lifecycle logic.
- Settlement views separate review queue, balances, batches and transactions instead of mixing all tasks at equal weight.

- [ ] **Step 1: Write RED tests for hierarchy and filtering**

Assert no more than four visible common filters, filter drawer accessibility, URL persistence, localized timeline stages, separate financial task regions, and mobile order cards with a visible next action.

- [ ] **Step 2: Run RED**

Expected: old order filter exposes all conditions and detail pages do not share a timeline.

- [ ] **Step 3: Implement UI-only reorganization**

Reuse existing queries/actions and status mappers. Do not alter settlement deadlines, wallet amounts, order state transitions, Jifeng dispatch or replacement rules.

- [ ] **Step 4: Run payment/fulfillment regression GREEN**

Run phase-two, phase-three and multi-store E2E on their intended projects; run relevant settlement/order integration tests to prove business behavior is unchanged.

- [ ] **Step 5: Commit**

```powershell
git commit -m "feat: reorganize order and settlement workspaces"
```

---

### Task 9: Refine Customer Import and Multi-Store Acquisition Flows

**Files:**
- Modify: `src/app/(customer)/portal/imports/new/page.tsx`
- Modify: `src/app/(customer)/portal/imports/[batchId]/page.tsx`
- Modify: `src/app/(customer)/portal/bulk-orders/page.tsx`
- Modify: `src/app/(customer)/portal/bulk-orders/[draftId]/page.tsx`
- Modify: `src/components/bulk-order/bulk-order-workspace.tsx`
- Modify: `src/components/bulk-order/store-group-card.tsx`
- Modify: `src/components/bulk-order/bulk-order-summary-bar.tsx`
- Modify: `tests/unit/bulk-order/bulk-order-workspace.test.tsx`
- Modify: `tests/e2e/multi-store-bulk-order.spec.ts`

**Interfaces:**
- Single-store flow explicitly displays steps `选择店铺`, `上传文件`, `校验预览`, `确认提交`.
- Multi-store workspace preserves existing draft, dedupe, selection, validation, partial submission and unified settlement behavior.
- Mobile still defaults to first submittable store expanded and later groups collapsed; summary continuously displays stores/orders/items/amount/blocked groups.

- [ ] **Step 1: Write RED tests for visible progress and recovery**

Assert step labels, selected store context, recoverable error categories, refresh-preserved draft/selection, continuation CTA, and 360/390/430 sticky summary without obstruction.

- [ ] **Step 2: Run RED**

Expected: at least the single-store flow lacks the approved continuous step model and list page does not prioritize continuation.

- [ ] **Step 3: Implement the task-flow presentation**

Only reorganize UI and copy. Reuse all draft, validation and submission services. Do not change 10MB file rules, dedupe, store ownership, idempotency, stock reservation or settlement behavior.

- [ ] **Step 4: Run full bulk-order GREEN and commit**

Run bulk-order unit, integration and desktop/mobile E2E, then typecheck/lint/diff. Commit:

```powershell
git commit -m "feat: refine customer acquisition flows"
```

---

### Task 10: Migrate Replacements, Reports, Notifications, Integrations, Health, and Audit

**Files:**
- Modify: `src/app/(admin)/admin/replacements/page.tsx`
- Modify: `src/app/(admin)/admin/reports/page.tsx`
- Modify: `src/app/(admin)/admin/notifications/page.tsx`
- Modify: `src/app/(admin)/admin/system/integrations/page.tsx`
- Modify: `src/app/(admin)/admin/system/health/page.tsx`
- Modify: `src/app/(admin)/admin/system/audit/page.tsx`
- Modify: `tests/e2e/phase-four-reports.spec.ts`
- Create: `tests/e2e/ui-v2-system-pages.spec.ts`

**Interfaces:**
- Replacements use action queue + history.
- Reports use trend/rank/coverage modules and tables only as supporting detail.
- Notifications use severity, impact and resolution state.
- Integrations show configured/unconfigured/degraded status without secrets.
- Health translates technical checks into operational impact and remains read-only.
- Audit uses compact common filters plus a more-filter drawer; event labels remain localized.

- [ ] **Step 1: Write RED E2E assertions per page type**

Assert each page exposes its domain-specific structure and actionable empty state, has no duplicate KPI, no raw enums/secrets, one page heading, one active navigation item and no horizontal overflow.

- [ ] **Step 2: Run RED**

Expected: current pages mostly retain generic metric-strip/panel layouts.

- [ ] **Step 3: Migrate one page at a time**

Reuse existing queries/actions; introduce no new business feature. After each page, run its test slice before moving to the next page.

- [ ] **Step 4: Run GREEN and commit**

Run reports and system-page E2E, full unit, typecheck/lint/diff. Commit:

```powershell
git commit -m "feat: migrate secondary admin workspaces"
```

---

### Task 11: Complete Visual, Responsive, Accessibility, and Release Acceptance

**Files:**
- Modify: `tests/e2e/merchant-center-visual.spec.ts`
- Modify: `tests/e2e/merchant-center-visual.spec.ts-snapshots/*.png`
- Modify: `tests/e2e/login-visual.spec.ts` only if the shared shell changes a public login assertion
- Create: `tests/e2e/ui-v2-responsive.spec.ts`
- Create: `docs/release-notes/2026-08-13-ui-v2.md`

**Interfaces:**
- The visual matrix includes both audiences and all five page types.
- Responsive matrix covers 1440x900, 1920x1080, 430x900, 390x844 and 360x800.
- Screenshots remain unmasked; deterministic database reset is required.

- [ ] **Step 1: Add final acceptance tests before snapshot updates**

Assert full-width 56px shell geometry, grouped navigation, one active item, no permanently expanded row forms, mobile no-overflow, >=44px key targets, axe serious/critical 0, no page errors, no hydration errors and no unhandled console errors.

- [ ] **Step 2: Run RED against any remaining legacy page**

Run the final acceptance file before changing remaining code/snapshots. Any failure must name a real structural or responsive gap, not merely a missing baseline.

- [ ] **Step 3: Fix only acceptance gaps and generate deterministic snapshots**

Do not hide text, make elements transparent, mask business values or weaken assertions. Review representative admin/customer desktop/mobile screenshots manually.

- [ ] **Step 4: Run complete verification**

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run test:e2e -- --workers 1
npm.cmd run typecheck
npm.cmd run lint
$env:DATABASE_URL='postgres://placeholder:placeholder@127.0.0.1:5432/placeholder'; $env:BETTER_AUTH_SECRET='build-only-secret-with-at-least-32-characters'; $env:BETTER_AUTH_URL='http://127.0.0.1:3000'; $env:PII_ENCRYPTION_KEY='AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='; npm.cmd run build
git diff --check
```

Expected: all test suites pass, E2E has 0 unexpected skips/failures, build succeeds, and git diff check is clean.

- [ ] **Step 5: Write release notes and commit**

Release notes must describe the new shell/navigation, account/customer redesign, admin/customer dashboards, domain-specific workspaces, responsive behavior and explicitly state that business state machines were unchanged.

```powershell
git add tests/e2e docs/release-notes/2026-08-13-ui-v2.md
git commit -m "test: complete ui v2 release acceptance"
```

---

## Plan Self-Review

### Spec coverage

- Global shell geometry and line alignment: Task 1.
- Admin/customer navigation grouping: Task 1.
- Shared drawers, danger zones, empty states: Task 2.
- Account management: Task 3.
- Customer list/detail/stores: Tasks 4–5.
- Admin operations dashboard and customer task home: Task 6.
- Catalog/inventory distinction: Task 7.
- Orders/settlement/wallet/timelines: Task 8.
- Single/multi-store customer flows: Task 9.
- Secondary/system pages: Task 10.
- Desktop/mobile/a11y/visual/build acceptance: Task 11.
- Integration credentials explicitly excluded: Global Constraints and spec non-goals.

### Sequencing

- Tasks 1–2 establish interfaces required by Tasks 3–10.
- Tasks 3–5 validate the highest-priority governance workflows before broad migration.
- Task 6 establishes dashboard query/component patterns.
- Tasks 7–10 migrate domains without overlapping file ownership.
- Task 11 is the only task allowed to approve/update the full visual baseline.

### Quality gates

- Every task starts with a real failing unit, integration or E2E assertion.
- Every task preserves existing state-machine regression coverage.
- Each task ends with focused gates and an independent commit suitable for task-level review.
- Final acceptance uses one clean database target, no screenshot masking and a production build.
