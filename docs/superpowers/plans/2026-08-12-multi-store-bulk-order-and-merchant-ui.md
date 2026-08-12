# 多店铺批量拿货与商家中心 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留同舟行既有单店流程的前提下，交付多店铺分组批量拿货、统一结算与余额冻结，补齐超级管理员账号/客户/店铺治理，并把管理员后台和客户门户整体升级为已批准的“同舟行商家工作台”视觉。

**Architecture:** PostgreSQL 继续作为订单、库存、资金和账号归属的唯一事实源。批量提交在事务中完成去重、短缺集合、逐店拿货单、库存和结算；账号服务在 Better Auth 之上增加唯一超级管理员、普通管理员、客户一对一账号、软停用和会话撤销边界。UI 先补齐账号/客户/店铺管理，再扩展共享设计令牌、双端壳和本地字体，最后迁移各业务页面。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 6 严格模式、PostgreSQL、Drizzle ORM、ExcelJS、Zod 4、Tailwind CSS 4、shadcn/Radix、Vitest、Testing Library、Playwright、axe-core。

## Global Constraints

- 平台名称固定为“同舟行跨境”，正式 Logo 使用 `public/brand/tongzhouxing-logo.png`。
- TikTok Shop 商家中心只作为 UI 美学和组件质感参考；不得复制其信息架构、栏目、角色或业务命名。
- 管理员和客户现有路由、权限、菜单功能与核心流程保持兼容；批量拿货作为客户默认推荐入口，单店上传继续可用。
- 系统只有一个不可停用、删除或降级的超级管理员；可有多个普通管理员，普通管理员无账号管理权限。
- 一位客户只能有一个登录账号，一个账号可访问该客户名下全部店铺；账号、客户和店铺只软停用，不物理删除。
- 停用任何普通管理员或客户账号必须立即撤销其全部会话；管理员端和客户端都必须提供退出登录。
- 全站字体固定为项目本地打包的 Geist Variable + Noto Sans SC Variable；所有页面和图表共享字体令牌，禁止页面单独覆盖字体。
- 登录页主标题固定为“加拿大本地货盘，选品拿货更简单。”，辅助说明固定为“连接 TEMU 多店铺、同舟行货盘与人民币结算，让选品、拿货、付款和发货记录都清晰可查。”
- 第一阶段只做浅色主题；深炭黑只用于全局工具顶栏和选中导航，不扩展为全页面深色主题。
- Logo 红不用于主操作；深海青绿继续作为主操作、链接和焦点色。
- 每个批量草稿最多 20 个店铺分组、每店 10 个文件、总计 100 个文件、单文件 10 MB、单文件最多 50,000 行，草稿有效期 24 小时。
- 同店多文件合并去重；相同文件或 TEMU 子订单跨店出现时阻止所有相关店铺；系统不猜测店铺归属。
- 分组存在未知 SKU、格式错误、跨店冲突或库存不足时整店阻止；其他店铺允许部分成功。
- 多店共同造成某 SKU 短缺时，所有涉及该 SKU 的店铺均失败，不按上传或提交顺序分配。
- 每个成功店铺生成一张独立拿货单；一次提交的成功店铺共同生成一个结算批次，后续修复的店铺生成新结算批次。
- 客户自定义余额抵扣金额；纯余额批次立即扣款，混合付款只冻结余额，统一线下核款后才正式扣款。
- 比例分摊以人民币分计算，先向下取整，尾差依拿货单金额降序、ID 升序补齐。
- 拒绝、撤回或超时必须原子释放有效余额冻结和相关库存；待统一核款时不得单独取消其中某张拿货单。
- 收件人 PII 继续加密存储，不得出现在批量摘要、错误、日志、审计或飞书通知中。
- 桌面端管理员页面以 1440px 验收；客户关键流程覆盖 360、390、430px；触控目标不小于 44px，目标 WCAG 2.2 AA。
- 所有行为变更遵循 TDD：先看到目标测试失败，再写最小实现并运行目标测试通过。

## File Structure Map

### Data and migrations

- Modify `src/db/schema/orders.ts`: 增加草稿、店铺分组、结算、冻结、统一付款声明和多文件关联表及枚举。
- Modify `src/db/schema/index.ts`: 导出新增表。
- Create `drizzle/0010_multi_store_bulk_order.sql`: 可回滚前向迁移、约束和索引。
- Create `drizzle/0011_bulk_submission_requests.sql`: 批量提交专用幂等请求表和客户作用域唯一约束。
- Create `drizzle/0012_settlement_timeout_review.sql`: 允许系统超时拒绝不伪造管理员身份，同时保留人工审核约束。
- Create `drizzle/0013_jifeng_reconciliation_claim.sql`: 极风对账租约所有权令牌，支持崩溃恢复与旧 worker 条件落账。
- Create `drizzle/0014_account_governance.sql`: 账号治理、唯一超级管理员与客户账号一对一约束。
- Modify `drizzle/meta/_journal.json`: 记录迁移序号。

### Bulk import domain

- Create `src/modules/bulk-order/types.ts`: 草稿、分组、校验和提交结果的公共领域类型。
- Create `src/modules/bulk-order/allocation.ts`: 纯函数金额分摊。
- Create `src/modules/bulk-order/conflicts.ts`: 纯函数跨店文件/子订单和短缺店铺集合计算。
- Create `src/modules/bulk-order/draft-service.ts`: 草稿、店铺分组、文件加入/移除、恢复和过期。
- Create `src/modules/bulk-order/validation-service.ts`: 合并文件、店内去重、跨店冲突、库存和价格预览。
- Create `src/modules/bulk-order/submission-service.ts`: 原子部分提交、订单/包裹/行/库存和结算批次创建。
- Create `src/modules/bulk-order/actions.ts`: 客户端 Server Actions 与 Zod 输入边界。
- Modify `src/modules/order-import/service.ts`: 允许现有解析结果写入店铺分组，复用单店解析能力。
- Modify `src/modules/order-import/actions.ts`: 保持旧入口并复用严格文件校验。

### Settlement domain

- Create `src/modules/settlement/batch-allocation.ts`: 结算批次分摊查询模型。
- Create `src/modules/settlement/batch-service.ts`: 余额冻结、声明、撤回、确认和拒绝。
- Create `src/modules/settlement/actions.ts`: 客户和管理员统一结算动作。
- Modify `src/modules/wallet/service.ts`: 可用余额、冻结、消费和释放。
- Modify `src/modules/wallet/queries.ts`: 返回账面、冻结和可用余额。
- Modify `src/modules/orders/lifecycle.ts`: 统一批次中的单订单取消保护与过期释放。
- Modify `src/jobs/worker.ts`: 扫描结算批次 2 小时/12 小时超时。

### Customer UI

- Create `src/app/(customer)/portal/bulk-orders/page.tsx`: 草稿列表和新建入口。
- Create `src/app/(customer)/portal/bulk-orders/[draftId]/page.tsx`: 多店分组编辑和预览。
- Create `src/app/(customer)/portal/settlements/[settlementId]/page.tsx`: 结算结果、付款声明和撤回。
- Create `src/components/bulk-order/bulk-order-workspace.tsx`: 多店分组客户端工作区。
- Create `src/components/bulk-order/store-group-card.tsx`: 单店上传、汇总和错误卡片。
- Create `src/components/bulk-order/bulk-order-summary-bar.tsx`: 粘性提交与资金汇总。
- Create `src/components/settlement/settlement-payment-form.tsx`: 统一线下付款声明。
- Modify `src/components/layout/customer-shell.tsx`: 加入批量拿货但保留原客户菜单功能。
- Modify `src/app/(customer)/portal/page.tsx`: 批量拿货成为推荐主操作。
- Modify `src/app/(customer)/portal/wallet/page.tsx`: 显示冻结和可用余额。

### Admin UI

- Create `src/app/(admin)/admin/bulk-orders/page.tsx`: 批量草稿诊断列表。
- Create `src/app/(admin)/admin/bulk-orders/[draftId]/page.tsx`: 草稿和分组只读诊断。
- Create `src/app/(admin)/admin/settlement-batches/page.tsx`: 统一结算与待核款列表。
- Create `src/app/(admin)/admin/settlement-batches/[settlementId]/page.tsx`: 分摊、冻结、审核和审计详情。
- Create `src/components/settlement/admin-settlement-review.tsx`: 一次确认或拒绝表单。
- Modify `src/components/layout/admin-shell.tsx`: 增加批量拿货诊断和统一结算入口，不删除原模块。
- Modify `src/app/(admin)/admin/settlement/page.tsx`: 链接新结算批次并保留原单订单核款。

### Account, customer and store management

- Modify `src/db/schema/auth.ts` and `identity.ts`: 客户账号唯一归属、超级管理员角色和管理员身份映射。
- Create `drizzle/0014_account_governance.sql`: 前向增加账号约束、超级管理员保护索引和兼容回填。
- Create `src/modules/accounts/service.ts`, `queries.ts`, `actions.ts`: 账号列表、创建普通管理员、资料修改、密码重置、停用/恢复和会话撤销。
- Modify `src/modules/identity/principal.ts` and `guards.ts`: 区分 `SUPER_ADMIN` 与普通 `ADMIN`，新增 `requireSuperAdmin()`。
- Expand `src/modules/customers/service.ts`, `actions.ts`, `queries.ts`: 客户和店铺完整资料维护、停用/恢复与审计。
- Create `src/app/(admin)/admin/accounts/page.tsx`: 仅超级管理员可见的管理员/客户账号管理。
- Create `src/app/(admin)/admin/customers/[customerId]/page.tsx`: 客户详情、唯一账号和多店铺管理。
- Modify `src/app/(admin)/admin/customers/page.tsx`: 显示账号状态、店铺数量和详情入口。

### Merchant-center UI system

- Install `@fontsource-variable/geist` and `@fontsource-variable/noto-sans-sc`: 字体资源随构建本地打包。
- Modify `src/app/globals.css` and `src/app/layout.tsx`: 落实本地字体、深炭黑顶栏、浅色侧栏/画布、面板、表格和状态令牌。
- Modify `src/app/(auth)/login/page.tsx`: 使用确认后的加拿大本地货盘文案。
- Create `src/components/auth/sign-out-button.tsx`: 双端明确退出入口。
- Create `src/components/layout/merchant-topbar.tsx`: 双端共享全局工具顶栏。
- Create `src/components/layout/page-heading.tsx`: 面包屑、标题、说明和单主操作。
- Create `src/components/data-workspace/metric-strip.tsx`: 连续指标带。
- Modify `src/components/layout/admin-shell.tsx`: 管理员商家中心壳。
- Modify `src/components/layout/customer-shell.tsx`: 客户商家中心壳与移动抽屉。
- Modify `src/components/ui/button.tsx`, `badge.tsx`, `input.tsx`, `select.tsx`, `table.tsx`, `tabs.tsx`, `sheet.tsx`: 小圆角、高密度和完整交互状态。
- Modify all page files under `src/app/(admin)/admin/**` and `src/app/(customer)/portal/**`: 用共享标题、指标带、面板和表格语言替换旧式大圆角卡片堆叠，不改业务内容。

### Tests and documentation

- Create `tests/unit/bulk-order/allocation.test.ts` and `conflicts.test.ts`.
- Create `tests/integration/bulk-order/schema.test.ts`, `draft.test.ts`, `validation.test.ts`, `submission.test.ts`, `concurrency.test.ts`.
- Create `tests/integration/settlement/batch-lifecycle.test.ts`.
- Create `tests/unit/ui/merchant-shell.test.tsx`.
- Create `tests/integration/accounts/governance.test.ts` and `tests/unit/accounts/account-management.test.tsx`.
- Modify `tests/integration/customers/provisioning.test.ts` and `tests/integration/identity/access-guards.test.ts`.
- Create `tests/e2e/multi-store-bulk-order.spec.ts` and `merchant-center-visual.spec.ts` plus approved snapshots.
- Modify `tests/e2e/phase-two-payment.spec.ts`, `tests/e2e/admin-management.spec.ts`, `tests/e2e/customer-catalog.spec.ts`: 兼容新壳和原流程回归。
- Modify `docs/operations/local-development.md` and `docs/releases/v0.2.0.md`: 迁移、运行和功能说明。

---

### Task 1: 金额分摊、冲突集合与领域类型

**Files:**
- Create: `src/modules/bulk-order/types.ts`
- Create: `src/modules/bulk-order/allocation.ts`
- Create: `src/modules/bulk-order/conflicts.ts`
- Test: `tests/unit/bulk-order/allocation.test.ts`
- Test: `tests/unit/bulk-order/conflicts.test.ts`

**Interfaces:**
- Produces: `allocateWalletFen(orders, requestedFen): WalletAllocation[]`
- Produces: `findCrossStoreConflicts(groups): CrossStoreConflictResult`
- Produces: `findGroupsAffectedByShortage(groups, availableBySku): StockConflictResult`

- [ ] **Step 1: 写金额分摊失败测试**

```ts
expect(allocateWalletFen([
  { orderId: "b", totalAmountFen: 100 },
  { orderId: "a", totalAmountFen: 100 },
  { orderId: "c", totalAmountFen: 101 },
], 100)).toEqual([
  { orderId: "a", walletFen: 33, offlineFen: 67 },
  { orderId: "b", walletFen: 33, offlineFen: 67 },
  { orderId: "c", walletFen: 34, offlineFen: 67 },
]);
```

- [ ] **Step 2: 运行分摊测试并确认失败**

Run: `npm test -- tests/unit/bulk-order/allocation.test.ts`

Expected: FAIL，提示 `allocateWalletFen` 尚不存在。

- [ ] **Step 3: 实现整数分摊和稳定尾差**

```ts
export function allocateWalletFen(orders: AllocationOrder[], requestedFen: number) {
  const total = orders.reduce((sum, order) => sum + order.totalAmountFen, 0);
  const walletTotal = Math.min(Math.max(0, requestedFen), total);
  const base = orders.map((order) => ({
    orderId: order.orderId,
    totalAmountFen: order.totalAmountFen,
    walletFen: Math.floor(walletTotal * order.totalAmountFen / total),
  }));
  let remainder = walletTotal - base.reduce((sum, row) => sum + row.walletFen, 0);
  for (const row of [...base].sort((a, b) => b.totalAmountFen - a.totalAmountFen || a.orderId.localeCompare(b.orderId))) {
    if (remainder-- <= 0) break;
    row.walletFen += 1;
  }
  return base.sort((a, b) => a.orderId.localeCompare(b.orderId)).map((row) => ({
    orderId: row.orderId,
    walletFen: row.walletFen,
    offlineFen: row.totalAmountFen - row.walletFen,
  }));
}
```

- [ ] **Step 4: 写跨店与短缺集合失败测试**

```ts
expect(findCrossStoreConflicts([
  { groupId: "g1", fileHashes: ["h1"], subOrderNos: ["s1"] },
  { groupId: "g2", fileHashes: ["h1"], subOrderNos: ["s2"] },
  { groupId: "g3", fileHashes: ["h3"], subOrderNos: ["s1"] },
]).blockedGroupIds).toEqual(new Set(["g1", "g2", "g3"]));

expect(findGroupsAffectedByShortage([
  { groupId: "g1", quantityBySku: new Map([["sku-a", 4]]) },
  { groupId: "g2", quantityBySku: new Map([["sku-a", 3]]) },
  { groupId: "g3", quantityBySku: new Map([["sku-b", 2]]) },
], new Map([["sku-a", 6], ["sku-b", 2]])).blockedGroupIds).toEqual(new Set(["g1", "g2"]));
```

- [ ] **Step 5: 实现冲突纯函数并通过单元测试**

Run: `npm test -- tests/unit/bulk-order/allocation.test.ts tests/unit/bulk-order/conflicts.test.ts`

Expected: 2 个测试文件全部 PASS；非法负金额、空订单、重复 groupId 也被测试拒绝。

- [ ] **Step 6: 提交纯领域逻辑**

```bash
git add src/modules/bulk-order tests/unit/bulk-order
git commit -m "feat: add bulk order allocation and conflict rules"
```

### Task 2: 批量草稿、结算批次与钱包冻结 schema

**Files:**
- Modify: `src/db/schema/orders.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0010_multi_store_bulk_order.sql`
- Modify: `drizzle/meta/_journal.json`
- Test: `tests/integration/bulk-order/schema.test.ts`

**Interfaces:**
- Produces tables: `bulkImportDrafts`, `bulkImportStoreGroups`, `fulfillmentOrderImportBatches`, `settlementBatches`, `settlementBatchOrders`, `walletHolds`, `settlementPaymentClaims`.
- Produces enum value: `fulfillment_payment_mode.MIXED`.

- [ ] **Step 1: 写 schema 约束失败测试**

```ts
await expect(sqlClient`insert into bulk_import_store_groups (draft_id, store_id, customer_id) values (${draftId}, ${storeId}, ${otherCustomerId})`).rejects.toThrow();
await expect(sqlClient`insert into wallet_holds (customer_id, settlement_batch_id, amount_fen, status) values (${customerId}, ${settlementId}, 0, 'ACTIVE')`).rejects.toThrow();
```

- [ ] **Step 2: 运行 schema 测试并确认表不存在**

Run: `npm run test:integration -- tests/integration/bulk-order/schema.test.ts`

Expected: FAIL，错误包含 `relation "bulk_import_drafts" does not exist`。

- [ ] **Step 3: 添加精确枚举、表和约束**

```ts
export const bulkImportDraftStatus = pgEnum("bulk_import_draft_status", ["DRAFT", "PARTIALLY_SUBMITTED", "COMPLETED", "EXPIRED"]);
export const walletHoldStatus = pgEnum("wallet_hold_status", ["ACTIVE", "CONSUMED", "RELEASED"]);
export const settlementBatchStatus = pgEnum("settlement_batch_status", ["PENDING_PAYMENT", "PAYMENT_REPORTED", "PAID", "REJECTED", "WITHDRAWN", "CANCELLED", "EXPIRED"]);
export const settlementPaymentClaimStatus = pgEnum("settlement_payment_claim_status", ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]);
```

约束必须包括：草稿内店铺唯一、分组的 `(store_id, customer_id)` 归属外键、一个导入文件只属于一个分组、一个拿货单关联多个导入批次、每结算批次最多一个有效冻结、每结算批次最多一个待审声明、金额非负/正数、分摊等式和状态原因要求。

- [ ] **Step 4: 生成并人工核对迁移**

Run: `npm run db:generate`

Expected: 只生成 `0010` 迁移；不得删除或重建历史订单、钱包和付款表。

- [ ] **Step 5: 应用迁移并通过 schema 测试**

Run: `npm run db:migrate && npm run test:integration -- tests/integration/bulk-order/schema.test.ts`

Expected: PASS，并验证旧 `payment_claims` 与单店订单数据仍可读取。

- [ ] **Step 6: 提交 schema**

```bash
git add src/db/schema drizzle tests/integration/bulk-order/schema.test.ts
git commit -m "feat: add bulk order and settlement schema"
```

### Task 3: 24 小时草稿与按店铺分组上传

**Files:**
- Modify: `next.config.ts`
- Create: `src/modules/bulk-order/draft-service.ts`
- Create: `src/modules/bulk-order/actions.ts`
- Modify: `src/modules/order-import/service.ts`
- Modify: `src/modules/order-import/temu-parser.ts`
- Test: `tests/integration/bulk-order/draft.test.ts`
- Test: `tests/unit/config/next-config.test.ts`

**Interfaces:**
- Produces: `createBulkDraft({ actorUserId, customerId }): Promise<BulkDraftView>`
- Produces: `addStoreGroup({ draftId, customerId, storeId }): Promise<StoreGroupView>`
- Produces: `uploadGroupFiles({ groupId, customerId, files }): Promise<StoreGroupView>`
- Produces: `getBulkDraft(customerId, draftId): Promise<BulkDraftView>`
- Produces: `removeGroupFile({ customerId, batchId }): Promise<void>`

- [ ] **Step 1: 写归属、限制和恢复失败测试**

```ts
await expect(addStoreGroup({ draftId, customerId, storeId: foreignStoreId })).rejects.toMatchObject({ code: "STORE_NOT_OWNED" });
await expect(uploadGroupFiles({ groupId, customerId, files: elevenFiles })).rejects.toMatchObject({ code: "GROUP_FILE_LIMIT" });
expect((await getBulkDraft(customerId, draftId)).expiresAt.getTime() - createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
```

- [ ] **Step 2: 运行目标测试并确认服务不存在**

Run: `npm run test:integration -- tests/integration/bulk-order/draft.test.ts`

Expected: FAIL，提示无法导入 `draft-service`。

- [ ] **Step 3: 实现草稿和分组事务**

```ts
export async function addStoreGroup(input: AddStoreGroupInput) {
  return db.transaction(async (tx) => {
    const draft = await lockOwnedActiveDraft(tx, input.customerId, input.draftId);
    await assertActiveOwnedStore(tx, input.customerId, input.storeId);
    const count = await countDraftGroups(tx, draft.id);
    if (count >= 20) throw new BulkDraftError("GROUP_LIMIT", "一个草稿最多添加 20 个店铺");
    return insertUniqueStoreGroup(tx, draft, input.storeId);
  });
}
```

- [ ] **Step 4: 复用 TEMU 解析器并严格验证文件**

逐文件验证 `.xlsx`、MIME、10 MB、33 列表头和 50,000 行；调用现有 PII 加密和精确 SKU 映射，将 `order_import_batches.store_group_id` 写入，不把完整收件信息写入错误或审计。

`next.config.ts` 必须把 Server Actions 请求体上限显式设为 `101mb`，覆盖单店一次最多 10 个、每个 10 MB 文件及 multipart 开销；逐文件 10 MB 和每组 10 文件仍由服务层独立校验，草稿总计 100 文件通过多次分组请求完成，不允许一次请求绕过分组限制。

- [ ] **Step 5: 通过草稿测试和原单店预览回归**

Run: `npm test -- tests/unit/config/next-config.test.ts && npm run test:integration -- tests/integration/bulk-order/draft.test.ts tests/integration/order-import/preview.test.ts`

Expected: PASS；20/10/100 限制、过期、重新登录读取、同店唯一和旧入口均有覆盖。

- [ ] **Step 6: 提交草稿服务**

```bash
git add next.config.ts src/modules/bulk-order src/modules/order-import tests/integration/bulk-order/draft.test.ts tests/unit/config/next-config.test.ts
git commit -m "feat: add multi-store bulk import drafts"
```

### Task 4: 同店去重、跨店冲突与库存预览

**Files:**
- Create: `src/modules/bulk-order/validation-service.ts`
- Modify: `src/modules/bulk-order/draft-service.ts`
- Test: `tests/integration/bulk-order/validation.test.ts`

**Interfaces:**
- Produces: `validateBulkDraft({ customerId, draftId }): Promise<BulkDraftValidationView>`
- Consumes: `findCrossStoreConflicts`, `findGroupsAffectedByShortage`.

- [ ] **Step 1: 写业务矩阵失败测试**

```ts
expect(result.groups.get(groupA)?.status).toBe("BLOCKED_CROSS_STORE");
expect(result.groups.get(groupB)?.status).toBe("BLOCKED_CROSS_STORE");
expect(result.groups.get(groupC)?.status).toBe("SUBMITTABLE");
expect(result.groups.get(groupC)?.deduplicatedOrderCount).toBe(8);
```

测试数据同时包含：文件内重复、跨文件重复、数据库已存在订单、相同文件跨店、子订单跨店、未知 SKU、格式错误和两店合计短缺。

- [ ] **Step 2: 运行并确认验证服务不存在**

Run: `npm run test:integration -- tests/integration/bulk-order/validation.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现确定性合并顺序**

```ts
const rows = batches
  .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  .flatMap((batch) => batch.rows.sort((a, b) => a.rowNumber - b.rowNumber));
const firstBySubOrder = new Map<string, ValidatedRow>();
for (const row of rows) if (!firstBySubOrder.has(row.externalSubOrderNo)) firstBySubOrder.set(row.externalSubOrderNo, row);
```

- [ ] **Step 4: 实现跨店和库存影响集合**

数据库已存在订单只排除对应行；未知 SKU/格式错误/跨店冲突阻止整组。库存按所有候选店铺聚合，任一 SKU 短缺即阻止所有涉及店铺，不修改库存。

- [ ] **Step 5: 通过验证、隐私和查询数量测试**

Run: `npm run test:integration -- tests/integration/bulk-order/validation.test.ts`

Expected: PASS；断言结果和日志不含姓名、电话和地址，100 个文件不会逐行 N+1 查询。

- [ ] **Step 6: 提交验证服务**

```bash
git add src/modules/bulk-order tests/integration/bulk-order/validation.test.ts
git commit -m "feat: validate grouped bulk order imports"
```

### Task 5: 原子部分提交与逐店拿货单

**Files:**
- Modify: `src/db/schema/orders.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0011_bulk_submission_requests.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `src/modules/bulk-order/submission-service.ts`
- Modify: `src/modules/orders/submission.ts`
- Modify: `src/modules/inventory/service.ts`
- Modify: `src/modules/wallet/service.ts`
- Test: `tests/integration/bulk-order/submission.test.ts`
- Test: `tests/integration/bulk-order/concurrency.test.ts`
- Test: `tests/integration/settlement/batch-lifecycle.test.ts`

**Interfaces:**
- Produces: `submitBulkDraft(input: SubmitBulkDraftInput): Promise<BulkSubmissionResult>`
- Produces: `SubmitBulkDraftInput = { actorUserId; customerId; draftId; selectedGroupIds; requestedWalletFen; idempotencyKey }`.
- Produces result per group with `ORDER_CREATED | STOCK_CHANGED | DUPLICATE_CHANGED | CROSS_STORE_CONFLICT | EXPIRED | INVALID`.

- [ ] **Step 1: 写 8 成功 2 失败和幂等失败测试**

```ts
const result = await submitBulkDraft(input);
expect(result.createdOrders).toHaveLength(8);
expect(result.failedGroups).toHaveLength(2);
expect(new Set(result.createdOrders.map((row) => row.storeId)).size).toBe(8);
expect((await submitBulkDraft(input)).settlementBatchId).toBe(result.settlementBatchId);
```

- [ ] **Step 2: 运行提交测试并确认失败**

Run: `npm run test:integration -- tests/integration/bulk-order/submission.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现最终锁定与重新校验事务**

```ts
return db.transaction(async (tx) => {
  const draft = await lockOwnedDraft(tx, input);
  const existing = await findIdempotentSubmission(tx, input.idempotencyKey);
  if (existing) return existing;
  const groups = await lockSelectedGroups(tx, draft.id, input.selectedGroupIds);
  const validated = await revalidateForSubmission(tx, groups);
  const eligible = validated.groups.filter((group) => group.status === "SUBMITTABLE");
  return createOrdersAndSettlement(tx, { ...input, draft, eligible, failed: validated.failed });
});
```

幂等状态必须写入专用 `bulk_submission_requests` 表，不得依赖 `audit_logs`。表至少包含 `customer_id`、`idempotency_key`、`payload_digest`、`draft_id`、`result_json`、可空 `settlement_batch_id` 和时间戳；`(customer_id, idempotency_key)` 唯一。先获取客户+key advisory lock，再读取/创建请求记录；同 payload 返回已存安全结果，不同 payload 拒绝。全失败请求也必须稳定重放，审计日志清理不得影响幂等。

- [ ] **Step 4: 创建逐店订单、多文件关联、包裹、行和库存锁定**

每个店铺只创建一张 `fulfillment_orders`；按 TEMU 主订单创建包裹，按子订单创建行；成交价使用提交时快照。SKU 行按稳定 ID 顺序 `FOR UPDATE`，受短缺 SKU 影响的组全部剔除后再创建库存锁定。

成功店铺确定后，在同一事务锁定客户钱包并计算最新可用余额。实际抵扣额为 `min(requestedWalletFen, 成功订单总额, 最新可用余额)`，重新按成功订单分摊并写入 `settlement_batch_orders`。纯余额时逐订单写 `ORDER_DEBIT` 并把订单置为 `PAID_PENDING_FULFILLMENT`；混合付款创建一条 `ACTIVE` wallet hold，不改变账面余额；零余额不创建 hold。`settlement_batches.wallet_amount_fen/offline_amount_fen` 必须始终对应已扣或已冻结的真实资金状态，不允许保存假定金额。

- [ ] **Step 5: 写并运行并发测试**

Run: `npm run test:integration -- tests/integration/bulk-order/concurrency.test.ts`

Expected: 两个并发批次竞争同一库存时不超卖；不受影响店铺仍成功；没有重复订单、结算批次或库存锁定。

- [ ] **Step 6: 运行旧单店提交回归**

Run: `npm run test:integration -- tests/integration/orders/submission.test.ts tests/integration/bulk-order/submission.test.ts tests/integration/bulk-order/concurrency.test.ts tests/integration/settlement/batch-lifecycle.test.ts`

Expected: 全部 PASS。

- [ ] **Step 7: 提交批量提交服务**

```bash
git add src/db/schema drizzle src/modules/bulk-order src/modules/orders/submission.ts src/modules/inventory/service.ts src/modules/wallet/service.ts tests/integration/bulk-order tests/integration/settlement/batch-lifecycle.test.ts
git commit -m "feat: submit bulk orders with partial success"
```

### Task 6: 钱包位置、冻结生命周期与分摊读模型

**Files:**
- Modify: `src/modules/wallet/service.ts`
- Modify: `src/modules/wallet/queries.ts`
- Create: `src/modules/settlement/batch-allocation.ts`
- Modify: `src/modules/bulk-order/submission-service.ts` only if required to expose the Task 5 transaction behavior through the public helpers.
- Test: `tests/integration/settlement/batch-lifecycle.test.ts`

**Interfaces:**
- Produces: `getWalletPosition(customerId): Promise<{ balanceFen; activeHoldFen; availableFen }>`
- Produces: `createWalletHold(tx, input): Promise<WalletHold>`
- Produces: `consumeWalletHold(tx, input): Promise<void>`
- Produces: `releaseWalletHold(tx, input): Promise<void>`

- [ ] **Step 1: 写可用余额和三种付款路径失败测试**

```ts
expect(await getWalletPosition(customerId)).toEqual({ balanceFen: 10000, activeHoldFen: 3000, availableFen: 7000 });
expect(fullWallet.orders.every((order) => order.status === "PAID_PENDING_FULFILLMENT")).toBe(true);
expect(mixed.walletHold?.status).toBe("ACTIVE");
expect(zeroWallet.walletHold).toBeNull();
```

- [ ] **Step 2: 运行结算测试并确认失败**

Run: `npm run test:integration -- tests/integration/settlement/batch-lifecycle.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现钱包位置和冻结并发保护**

```ts
const [account] = await tx.select().from(walletAccounts).where(eq(walletAccounts.customerId, customerId)).for("update");
const activeHoldFen = await sumActiveHolds(tx, customerId);
const availableFen = account.balanceFen - activeHoldFen;
if (requestedFen > availableFen) throw new SettlementError("INSUFFICIENT_AVAILABLE_BALANCE", "可用余额不足");
```

- [ ] **Step 4: 验证分摊和部分成功重算并补齐公共生命周期函数**

Task 5 已在提交事务中落实实际抵扣、分摊、纯余额扣款和混合冻结。本 Task 将该逻辑收敛为 `createWalletHold`、`consumeWalletHold`、`releaseWalletHold` 和 `getWalletPosition` 公共接口，增加 `batch-allocation` 读模型，并验证重复调用、冻结释放和后续核款所需的幂等边界。

- [ ] **Step 5: 通过钱包、分摊和旧钱包回归**

Run: `npm run test:integration -- tests/integration/settlement/batch-lifecycle.test.ts tests/integration/wallet/service.test.ts`

Expected: PASS；钱包不会负数，多个活跃批次不会重复使用已冻结余额。

- [ ] **Step 6: 提交钱包冻结**

```bash
git add src/modules/wallet src/modules/settlement src/modules/bulk-order/submission-service.ts tests/integration/settlement
git commit -m "feat: add wallet holds for bulk settlement"
```

### Task 7: 统一线下付款、管理员审核与超时恢复

**Files:**
- Modify: `src/db/schema/orders.ts`
- Modify: `src/db/schema/fulfillment.ts`
- Create: `drizzle/0012_settlement_timeout_review.sql`
- Create: `drizzle/0013_jifeng_reconciliation_claim.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `src/modules/settlement/batch-service.ts`
- Create: `src/modules/settlement/actions.ts`
- Modify: `src/modules/orders/lifecycle.ts`
- Modify: `src/jobs/worker.ts`
- Test: `tests/integration/settlement/batch-lifecycle.test.ts`
- Modify: `tests/integration/orders/lifecycle.test.ts`

**Interfaces:**
- Produces: `reportSettlementPayment(input): Promise<SettlementBatchView>`
- Produces: `withdrawSettlementPayment(input): Promise<SettlementBatchView>`
- Produces: `reviewSettlementPayment({ decision: "APPROVE" | "REJECT", ... }): Promise<void>`
- Produces: `expireSettlementBatches(now): Promise<number>`

- [ ] **Step 1: 写确认、拒绝、撤回、2 小时和 12 小时失败测试**

```ts
await reportSettlementPayment({ settlementBatchId, amountFen: offlineFen, note: "微信已付", customerId, actorUserId });
await reviewSettlementPayment({ settlementBatchId, decision: "APPROVE", adminUserId });
expect(await orderStatuses(settlementBatchId)).toEqual(["PAID_PENDING_FULFILLMENT", "PAID_PENDING_FULFILLMENT"]);
```

拒绝/撤回/超时用同一组断言：冻结为 `RELEASED`、库存锁定为 `RELEASED`、订单取消或过期、无极风任务、审计含明确原因。

- [ ] **Step 2: 运行目标测试并确认失败**

Run: `npm run test:integration -- tests/integration/settlement/batch-lifecycle.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现统一声明和原子审核**

```ts
await tx.update(walletHolds).set({ status: "CONSUMED", consumedAt: now }).where(and(eq(walletHolds.settlementBatchId, id), eq(walletHolds.status, "ACTIVE")));
for (const allocation of allocations) await debitWalletForAllocatedOrder(tx, allocation);
await markAllSettlementOrdersPaid(tx, id, now);
await enqueueEligibleFulfillmentJobs(tx, id);
```

声明金额必须精确等于线下待付额；管理员不能部分确认。待声明 2 小时，已声明 12 小时。重复审核通过幂等返回，不重复扣款。

系统 12 小时超时拒绝不得伪造管理员身份。`settlement_payment_claims_review_details_required` 调整为：`APPROVED` 必须同时有 `reviewed_at` 和真实 `reviewed_by_admin_user_id`；`REJECTED` 必须有 `reviewed_at` 与非空拒绝原因，允许系统超时时管理员字段为空。人工拒绝仍由服务层强制有效管理员。迁移仅前向放宽该检查约束，不删除或改写历史声明。

- [ ] **Step 4: 阻止统一待核款中的单订单取消**

`requestOrderCancellation` 和管理员取消入口在发现待审 `settlement_payment_claims` 时返回 `SETTLEMENT_CLAIM_PENDING`，文案要求先撤回整笔声明。

- [ ] **Step 5: worker 接入超时任务**

Worker 每分钟调用 `expireSettlementBatches(new Date())`；查询使用状态/截止时间索引，逐批事务加行锁并保持幂等。

极风创建/对账 outbox 使用可空 UUID `claim_token` 与 `locked_at` 组成可恢复租约；对账 worker 领取时写随机 token，落账必须同时匹配 `PROCESSING` 与 token。活动租约禁止管理员重试，过期租约在精确边界 `locked_at + lease <= now` 后只允许先查远端，不得盲目创建。迁移 0013 仅前向增加列和索引，不改变 `attempt_count` 创建尝试语义，也不向 payload 写入内部控制字段。

- [ ] **Step 6: 通过新旧生命周期回归**

Run: `npm run test:integration -- tests/integration/settlement/batch-lifecycle.test.ts tests/integration/orders/lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交统一结算生命周期**

```bash
git add src/db/schema/orders.ts src/db/schema/fulfillment.ts drizzle src/modules/settlement src/modules/orders/lifecycle.ts src/modules/fulfillment src/integrations/jifeng src/jobs/worker.ts tests
git commit -m "feat: add unified offline settlement review"
```

### Task 8: 客户多店铺批量拿货 UI

**Files:**
- Create: `src/app/(customer)/portal/bulk-orders/page.tsx`
- Create: `src/app/(customer)/portal/bulk-orders/[draftId]/page.tsx`
- Create: `src/app/(customer)/portal/settlements/[settlementId]/page.tsx`
- Create: `src/components/bulk-order/bulk-order-workspace.tsx`
- Create: `src/components/bulk-order/store-group-card.tsx`
- Create: `src/components/bulk-order/bulk-order-summary-bar.tsx`
- Create: `src/components/settlement/settlement-payment-form.tsx`
- Modify: `src/components/layout/customer-shell.tsx`
- Modify: `src/app/(customer)/portal/page.tsx`
- Modify: `src/app/(customer)/portal/wallet/page.tsx`
- Test: `tests/unit/bulk-order/bulk-order-workspace.test.tsx`
- Test: `tests/e2e/multi-store-bulk-order.spec.ts`

**Interfaces:**
- Consumes Server Actions from `bulk-order/actions.ts` and `settlement/actions.ts`.
- Produces accessible workflow for draft list, group editing, selection, wallet input, partial result and unified payment.

- [ ] **Step 1: 写组件失败测试**

```tsx
render(<BulkOrderWorkspace draft={fixtureDraft} walletPosition={{ balanceFen: 10000, activeHoldFen: 2000, availableFen: 8000 }} />);
expect(screen.getByText("8 个店铺可提交")).toBeVisible();
expect(screen.getByLabelText("本次余额抵扣")).toHaveValue(0);
expect(screen.getByRole("button", { name: "提交 8 个店铺" })).toBeEnabled();
```

- [ ] **Step 2: 运行组件测试并确认失败**

Run: `npm test -- tests/unit/bulk-order/bulk-order-workspace.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现草稿和分组卡片**

每个分组显示店铺、文件、原始/去重订单、件数、金额、未知 SKU、格式、跨店和库存状态；默认勾选可提交组，被阻止组禁用并给出修复入口。文件上传保留输入和进度，错误聚焦到首个问题。

- [ ] **Step 4: 实现粘性汇总和提交结果**

汇总显示店铺/文件/订单/件数/总额/账面/冻结/可用/抵扣/微信待付。提交后成功组显示拿货单号并从编辑区移除，失败组保留文件和错误；跳转新结算结果页。

- [ ] **Step 5: 实现统一付款和钱包展示**

声明表单金额只读等于微信待付，可填备注；待审核时显示撤回整笔声明。钱包页同时展示账面余额、已冻结、可用余额和冻结历史。

- [ ] **Step 6: 通过组件和 360/390/430px E2E**

Run: `npm test -- tests/unit/bulk-order/bulk-order-workspace.test.tsx && npm run test:e2e -- tests/e2e/multi-store-bulk-order.spec.ts`

Expected: PASS；移动端无页面级横向滚动，主要操作触控区域至少 44px。

- [ ] **Step 7: 提交客户 UI**

```bash
git add src/app/\(customer\) src/components/bulk-order src/components/settlement src/components/layout/customer-shell.tsx tests
git commit -m "feat: add customer bulk ordering workspace"
```

### Task 9: 管理员批量诊断与统一核款 UI

**Files:**
- Create: `src/app/(admin)/admin/bulk-orders/page.tsx`
- Create: `src/app/(admin)/admin/bulk-orders/[draftId]/page.tsx`
- Create: `src/app/(admin)/admin/settlement-batches/page.tsx`
- Create: `src/app/(admin)/admin/settlement-batches/[settlementId]/page.tsx`
- Create: `src/components/settlement/admin-settlement-review.tsx`
- Modify: `src/components/layout/admin-shell.tsx`
- Modify: `src/app/(admin)/admin/settlement/page.tsx`
- Test: `tests/unit/settlement/admin-settlement-review.test.tsx`
- Modify: `tests/e2e/multi-store-bulk-order.spec.ts`

**Interfaces:**
- Consumes admin settlement actions and read models.
- Produces list/detail pages that never expose decrypted recipient PII in summaries.

- [ ] **Step 1: 写管理员审核组件失败测试**

```tsx
expect(screen.getByText("统一核款：8 张拿货单")).toBeVisible();
expect(screen.getByText("余额冻结 ¥86.00")).toBeVisible();
expect(screen.getByRole("button", { name: "确认已收款" })).toBeEnabled();
expect(screen.getByRole("button", { name: "拒绝付款声明" })).toBeEnabled();
```

- [ ] **Step 2: 运行并确认页面/组件不存在**

Run: `npm test -- tests/unit/settlement/admin-settlement-review.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现批量草稿只读诊断**

列表支持客户、店铺、状态和时间筛选；详情显示文件摘要、冲突、错误码和部分提交结果，不提供替客户修改文件的能力，不显示完整收件人数据。

- [ ] **Step 4: 实现结算批次列表与一次审核**

详情固定展示总额、余额抵扣、微信待付、逐店拿货单分摊、冻结状态、付款声明和审计。确认/拒绝使用影响范围明确的确认对话框，拒绝原因必填，不允许改单店分摊或部分确认。

- [ ] **Step 5: 保留原单订单核款入口**

`/admin/settlement` 继续管理旧单店 `payment_claims`，同时提供“统一结算批次”入口和待审数量；不得迁移或隐藏历史核款记录。

- [ ] **Step 6: 通过管理员组件与 E2E**

Run: `npm test -- tests/unit/settlement/admin-settlement-review.test.tsx && npm run test:e2e -- tests/e2e/multi-store-bulk-order.spec.ts`

Expected: PASS；客户账号访问管理员 URL 返回安全拒绝页。

- [ ] **Step 7: 提交管理员 UI**

```bash
git add src/app/\(admin\) src/components/settlement src/components/layout/admin-shell.tsx tests
git commit -m "feat: add admin bulk settlement workspace"
```

### Task 10: 超级管理员账号、客户与店铺完整管理

**Files:**
- Modify: `src/db/schema/auth.ts`
- Modify: `src/db/schema/identity.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0014_account_governance.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `src/modules/accounts/service.ts`
- Create: `src/modules/accounts/queries.ts`
- Create: `src/modules/accounts/actions.ts`
- Modify: `src/modules/identity/auth.ts`
- Modify: `src/modules/identity/principal.ts`
- Modify: `src/modules/identity/guards.ts`
- Modify: `src/modules/customers/service.ts`
- Create: `src/modules/customers/queries.ts`
- Modify: `src/modules/customers/actions.ts`
- Create: `src/app/(admin)/admin/accounts/page.tsx`
- Modify: `src/app/(admin)/admin/customers/page.tsx`
- Create: `src/app/(admin)/admin/customers/[customerId]/page.tsx`
- Modify: `src/components/layout/admin-shell.tsx`
- Test: `tests/integration/accounts/governance.test.ts`
- Modify: `tests/integration/customers/provisioning.test.ts`
- Modify: `tests/integration/identity/access-guards.test.ts`
- Test: `tests/unit/accounts/account-management.test.tsx`
- Modify: `tests/e2e/admin-management.spec.ts`

**Interfaces:**
- Produces: `requireSuperAdmin(): Promise<SuperAdminPrincipal>` while `requireAdmin()` continues to accept both administrator roles.
- Produces: `listManagedAccounts()`, `createAdminAccount()`, `updateManagedAccount()`, `resetManagedAccountPassword()`, `setManagedAccountStatus()`.
- Produces: `getCustomerManagementDetail()`, `updateCustomer()`, `createStore()`, `updateStore()`, `setCustomerStatus()`, `setStoreStatus()`.

- [ ] **Step 1: 写唯一超级管理员和客户账号一对一失败测试**

```ts
await expect(createAdminAccount({ role: "SUPER_ADMIN", ...input })).rejects.toThrow("SUPER_ADMIN_IMMUTABLE");
await expect(createCustomerAccount({ customerId, ...secondAccount })).rejects.toThrow();
await expect(setManagedAccountStatus({ actor: ordinaryAdmin, userId, status: "DISABLED" })).rejects.toMatchObject({ code: "FORBIDDEN_SUPER_ADMIN" });
```

测试同时断言：超级管理员自身不能停用/降级；普通管理员不能访问账号服务；客户账号行返回所属客户与 `storeCount`。

- [ ] **Step 2: 运行并确认权限与数据库约束缺失**

Run: `npm run test:integration -- tests/integration/accounts/governance.test.ts tests/integration/identity/access-guards.test.ts`

Expected: FAIL，提示 `requireSuperAdmin` 或唯一约束尚不存在。

- [ ] **Step 3: 增加 0014 前向迁移和角色边界**

`auth_users.role` 固定使用 `super_admin | admin | user`；0014 迁移把现有唯一管理员账号提升为 `super_admin`，对 `role = 'super_admin'` 建立唯一部分索引，对非空 `customer_id` 建立唯一部分索引，并保证管理员 `customer_id is null`、客户账号 `role = 'user' and customer_id is not null`。迁移不得删除现有账号、会话或审计历史。

Better Auth 的管理员插件只把 `super_admin` 配置为拥有用户管理权限；`admin` 由应用 `requireAdmin()` 识别为日常运营角色，但不能调用账号管理 API。`SuperAdminPrincipal` 与 `AdminPrincipal` 明确区分，`requireAdmin()` 接受二者，`requireSuperAdmin()` 只接受前者。

- [ ] **Step 4: 实现账号服务与软停用**

所有账号写操作由 `requireSuperAdmin()` 保护并写审计。创建普通管理员固定 `role = 'admin'`；客户账号固定与一个客户一对一。更新显示名称/邮箱时同步 Better Auth 与身份映射；重置密码使用 Better Auth 密码能力；停用使用 ban/status 并在同一业务操作中撤销该用户全部会话；恢复解除 ban/status。任何服务均拒绝修改唯一超级管理员的角色或状态，不暴露物理删除入口。

- [ ] **Step 5: 补齐客户与多店铺管理服务**

客户列表查询返回唯一账号状态和店铺数量；详情返回客户资料、账号摘要和全部店铺。支持修改客户编号/名称/联系人/微信，客户与店铺启用/停用，添加店铺，修改店铺名称、平台、外部编号。停用客户同时停用唯一客户账号并撤销会话；停用店铺只禁止新拿货，不删除历史数据。每次变更记录前后值、操作者和原因。

- [ ] **Step 6: 实现账号页和客户详情页**

`/admin/accounts` 使用“管理员账号/客户账号”标签；每行显示显示名称、邮箱、角色/所属客户、状态、最近登录、客户店铺数和允许操作。超级管理员行不显示停用/角色操作。`/admin/customers` 显示账号状态、店铺数量和详情入口；详情页承载资料编辑、唯一账号摘要与多店铺新增/编辑/停用/恢复。普通管理员访问 `/admin/accounts` 返回安全拒绝页，且侧栏不显示“账号管理”；其他客户与店铺日常管理继续对管理员开放。

- [ ] **Step 7: 通过账号、客户、权限和浏览器回归**

Run: `npm run test:integration -- tests/integration/accounts/governance.test.ts tests/integration/customers/provisioning.test.ts tests/integration/identity/access-guards.test.ts && npm test -- tests/unit/accounts/account-management.test.tsx && npm run test:e2e -- tests/e2e/admin-management.spec.ts`

Expected: PASS；普通管理员不能看账号管理，超级管理员能完成创建、修改、重置密码、停用和恢复；停用账号旧会话失效；客户店铺数量准确。

- [ ] **Step 8: 提交账号、客户与店铺治理**

```bash
git add src/db/schema src/modules/accounts src/modules/identity src/modules/customers src/app/\(admin\)/admin/accounts src/app/\(admin\)/admin/customers src/components/layout/admin-shell.tsx drizzle tests
git commit -m "feat: add super admin account governance"
```

### Task 11: 商家中心设计令牌、共享顶栏、字体与会话入口

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/app/(auth)/login/page.tsx`
- Create: `src/components/auth/sign-out-button.tsx`
- Create: `src/components/layout/merchant-topbar.tsx`
- Create: `src/components/layout/page-heading.tsx`
- Create: `src/components/data-workspace/metric-strip.tsx`
- Modify: `src/components/layout/admin-shell.tsx`
- Modify: `src/components/layout/customer-shell.tsx`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/components/ui/badge.tsx`
- Modify: `src/components/ui/input.tsx`
- Modify: `src/components/ui/select.tsx`
- Modify: `src/components/ui/table.tsx`
- Modify: `src/components/ui/tabs.tsx`
- Test: `tests/unit/ui/merchant-shell.test.tsx`
- Modify: `tests/unit/ui/login-page.test.tsx`
- Test: `tests/unit/auth/sign-out-button.test.tsx`

**Interfaces:**
- Produces: `<MerchantTopbar audience="admin" | "customer" />`
- Produces: `<PageHeading breadcrumbs title description action />`
- Produces: `<MetricStrip items />`
- Produces: one global `--font-product` token backed by local Geist Variable + Noto Sans SC Variable assets.
- Produces: `<SignOutButton />` used by both authenticated shells.

- [ ] **Step 1: 写结构和令牌失败测试**

```tsx
render(<AdminShell><div>内容</div></AdminShell>);
expect(screen.getByRole("banner")).toHaveAttribute("data-merchant-topbar", "admin");
expect(screen.getByRole("navigation", { name: "管理员主导航" })).toBeVisible();
expect(screen.getByText("运营总览")).toBeVisible();
```

测试同时断言客户壳不出现管理员栏目，原路由标签都存在。

测试还断言登录页出现“加拿大本地货盘，选品拿货更简单。”和确认后的辅助说明，双端壳都有“退出登录”，全局布局导入两套本地字体且页面源代码没有独立 `font-family` 覆盖。

- [ ] **Step 2: 运行并确认新顶栏不存在**

Run: `npm test -- tests/unit/ui/merchant-shell.test.tsx tests/unit/ui/login-page.test.tsx tests/unit/auth/sign-out-button.test.tsx`

Expected: FAIL，新顶栏、退出按钮或字体资源尚不存在。

- [ ] **Step 3: 落实设计令牌**

```css
:root {
  --merchant-topbar: #171a1b;
  --merchant-canvas: #f4f5f5;
  --merchant-sidebar: #fafbfb;
  --merchant-panel: #ffffff;
  --primary: oklch(0.55 0.105 180);
  --radius-surface: 0.375rem;
}
```

安装 `@fontsource-variable/geist@5.3.0` 和 `@fontsource-variable/noto-sans-sc@5.3.0`。根布局导入本地字体 CSS，`--font-product` 固定为 `Geist Variable`, `Noto Sans SC Variable`, metric-compatible system fallbacks；`body`、Tailwind `font-sans/font-heading`、表单、按钮、表格、浮层和图表继承同一令牌。完整令牌还必须定义顶栏文字、侧栏悬停/选中、面板边框、表头、焦点、语义状态及 reduced-motion。运行 `rg -n "font-family|font-\[" src`，除 `globals.css` 的令牌声明外不得存在页面级覆盖。

- [ ] **Step 4: 实现共享顶栏和双端壳**

桌面使用 48–52px 深炭黑顶栏和 208–224px 浅色侧栏；顶栏只含品牌/帮助/消息/通知/账号。账号菜单包含明确的“退出登录”，调用 `authClient.signOut()`，成功后替换到 `/login` 并刷新；管理员与客户各自保留原业务导航；移动端侧栏变抽屉，顶栏压缩为菜单、品牌、通知、账号。登录页主标题和辅助说明使用已确认的固定文案。

- [ ] **Step 5: 收敛核心组件外观**

按钮、输入、选择、表格、页签、徽标使用 4–8px 小圆角；主按钮深海青绿；静态容器不加宽阴影；表格 40–48px 行高，金额/数字等宽右对齐；焦点可见且对比度满足 AA。

- [ ] **Step 6: 通过壳测试、类型和 lint**

Run: `npm test -- tests/unit/ui/merchant-shell.test.tsx tests/unit/ui/login-page.test.tsx tests/unit/auth/sign-out-button.test.tsx && npm run typecheck && npm run lint`

Expected: PASS，且没有丢失现有导航项。

- [ ] **Step 7: 提交设计系统基础**

```bash
git add package.json package-lock.json src/app src/components/auth src/components/layout src/components/data-workspace src/components/ui tests/unit
git commit -m "feat: add merchant workspace typography and shell"
```

### Task 12: 全系统页面视觉迁移

**Files:**
- Modify: all `page.tsx` files under `src/app/(admin)/admin/**`
- Modify: all `page.tsx` files under `src/app/(customer)/portal/**`
- Modify: `src/components/data-workspace/data-workspace-toolbar.tsx`
- Modify: `src/components/data-workspace/exception-queue.tsx`
- Modify: `src/components/data-workspace/responsive-data-table.tsx`
- Modify: existing order, payment, catalog, inventory, fulfillment and form components used by those pages.
- Test: `tests/e2e/merchant-center-visual.spec.ts`
- Modify: existing E2E snapshots.

**Interfaces:**
- Consumes: `PageHeading`, `MetricStrip`, shared panel/table/form tokens.
- Produces: consistent merchant-center appearance without route or content changes.

- [ ] **Step 1: 写跨页面视觉结构失败测试**

```ts
for (const path of ["/admin", "/admin/orders", "/admin/inventory", "/admin/settlement", "/portal", "/portal/catalog", "/portal/bulk-orders"]) {
  await page.goto(path);
  await expect(page.locator("[data-merchant-topbar]")).toBeVisible();
  await expect(page.locator("main")).toHaveCSS("background-color", "rgb(244, 245, 245)");
}
```

- [ ] **Step 2: 运行结构/快照测试并确认旧风格失败**

Run: `npm run test:e2e -- tests/e2e/merchant-center-visual.spec.ts`

Expected: FAIL，旧页面缺少共享标题/指标带或快照不匹配。

- [ ] **Step 3: 迁移管理员页面**

按顺序迁移运营总览、客户与店铺、商品与 SKU、库存、订单、补发、收款、报表、通知、集成、健康和审计。保持现有查询、筛选、按钮和字段；把独立大卡片改成连续指标带、白色数据面板、细分隔线和紧凑工具栏。

- [ ] **Step 4: 迁移客户页面**

迁移工作台、货盘、单店上传、预览、订单、订单详情、待付款、钱包和批量拿货。客户触控目标继续至少 44px，当前店铺和主要下一步操作清晰可见。

- [ ] **Step 5: 更新真实视觉快照并人工核对**

Run: `npm run test:e2e -- tests/e2e/merchant-center-visual.spec.ts --update-snapshots`

只在人工查看桌面管理员、桌面客户、390px 客户和 390px 管理员截图，确认无截断、重叠、旧大圆角卡片堆叠和 TikTok 特有栏目后保留新快照。

- [ ] **Step 6: 通过既有页面回归和 axe**

Run: `npm run test:e2e -- tests/e2e/admin-management.spec.ts tests/e2e/customer-catalog.spec.ts tests/e2e/phase-two-payment.spec.ts tests/e2e/merchant-center-visual.spec.ts`

Expected: PASS；所有 axe 扫描无 serious/critical 问题。

- [ ] **Step 7: 提交全站视觉迁移**

```bash
git add src/app src/components tests/e2e
git commit -m "feat: redesign application as merchant workspace"
```

### Task 13: 安全、兼容、运维文档与完整验收

**Files:**
- Modify: `docs/operations/local-development.md`
- Create: `docs/releases/v0.2.0.md`
- Modify: `.env.example` only if a new non-secret config is required.
- Modify: tests discovered by the complete gate only to correct genuine regressions, never to weaken assertions.

**Interfaces:**
- Produces release-ready v0.2.0 behavior and operator instructions.

- [ ] **Step 1: 增加最终安全回归断言**

验证客户 A 不能读写客户 B 的草稿、文件、店铺、结算和订单；普通管理员不能进入账号管理或修改账号；唯一超级管理员不能被停用、删除或降级；停用账号的全部会话失效；批量错误/审计/日志不含真实姓名、电话、邮箱或地址；重复提交/核款/worker 重试不重复扣款和锁库存。

- [ ] **Step 2: 执行完整单元测试**

Run: `npm test`

Expected: 全部 PASS，0 skipped（明确标注仅外部正式凭证才能运行的测试除外）。

- [ ] **Step 3: 执行完整集成测试**

Run: `npm run test:integration`

Expected: 全部 PASS，数据库约束、并发、资金和库存测试无失败。

- [ ] **Step 4: 执行类型、代码检查和生产构建**

Run: `npm run typecheck && npm run lint && npm run build`

Expected: 三条命令退出码均为 0。

- [ ] **Step 5: 执行完整浏览器验收**

Run: `npm run test:e2e`

Expected: 全部桌面、360/390/430px、视觉快照和可访问性测试 PASS。

- [ ] **Step 6: 更新操作与发布说明**

`local-development.md` 写明 0010/0011/0012/0013/0014 迁移、批量草稿/结算超时 worker、本地字体依赖和测试命令；`v0.2.0.md` 记录批量拿货、统一结算、余额冻结、专用幂等请求、账号/客户/店铺治理、退出登录、旧流程兼容、商家中心 UI 和已知外部集成前置条件。

- [ ] **Step 7: 检查版本库范围并提交验收**

Run: `git status --short && git diff --check && git log --oneline --decorate -15`

只提交本计划产生的源文件、迁移、测试、快照和文档，不提交 `.env.local`、`.codex-temp/` 或 `.superpowers/`。

```bash
git add .env.example docs src tests drizzle package-lock.json package.json
git commit -m "chore: complete bulk ordering and merchant UI acceptance"
```

## Definition of Done

- 客户可在一个 24 小时草稿中按最多 20 个店铺分组上传 TEMU 原始 Excel，并在桌面和手机上完成预览、选择、提交和后续付款。
- 同店多文件合并去重，跨店文件/子订单冲突清楚阻止，未知 SKU/格式/库存只影响相关店铺。
- 最终提交防止重复和超卖，允许店铺级部分成功，并为每个成功店铺生成独立拿货单和共同结算批次。
- 自定义余额抵扣、比例分摊、纯余额直扣、混合付款冻结和零余额线下付款均与规范一致。
- 一笔统一付款声明由管理员一次确认；拒绝、撤回和超时原子释放冻结与库存；旧单店付款流程继续工作。
- 系统只有一个受保护的超级管理员；超级管理员可管理普通管理员和客户账号，普通管理员不能进入账号管理。
- 一位客户只有一个登录账号并可管理多个店铺；账号、客户和店铺均采用保留历史的软停用，停用账号立即撤销会话。
- 管理员和客户全系统均采用商家中心视觉，保留同舟行原信息结构，无 TikTok 特有业务栏目。
- 登录页使用已确认的加拿大本地货盘文案；双端均可退出登录；全站统一使用项目本地打包的 Geist Variable + Noto Sans SC Variable 字体令牌。
- PII、客户隔离、幂等、并发、资金流水和库存流水通过自动化测试。
- 完整 unit、integration、typecheck、lint、build、E2E、axe 和视觉快照门禁全部通过。
