# 跨境系统业务逻辑与安全审计（2026-08-20）

## 范围与结论

- 基线：`codex/sku-management` / `faad1aa21dc94f6c6ad04234695ae19ce15468e6`。
- 发布候选：`codex/sku-management-audit-20260820`。
- 审计范围：飞书货盘、商品与 SKU、库存与流水、订单导入、金额与结算、极风履约、Outbox、权限、PII、异常恢复和管理端展示。
- 结论：未发现遗留 Critical 代码缺陷；已修复 6 组 Important/Moderate 缺陷和 2 组测试基础设施缺口。仍有 1 个 Important 产品决策缺口：已付款父拿货单的“子包裹独立取消”缺少金额调整和退款状态机。在政策确定前，不应把该能力作为完整的生产闭环上线。
- 本次只修改并验证本地发布候选；没有部署、没有执行生产迁移、没有重启生产容器、没有写入生产业务数据。

## 业务不变量与状态机

1. 飞书源货盘只读。只有 `FEISHU_CARGO_WRITES_ENABLED=true` 才可能写入另一个目标测试表；发布配置必须保持 `false`。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\.env.example:30-33`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\playwright.config.ts:90`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\feishu\source-protection.test.ts:317-318,374,401-402`。
2. SKU 解析优先级固定为“店铺专属映射 > 全局映射 > 在售标准 SKU 精确码”。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\order-import\service.ts:89-124`，优先级反证测试：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\order-import\preview.test.ts:245-375`。
3. 订单提交必须再次校验活动去重键、SKU 在售状态和库存，并在 SKU 行锁下建立库存锁定，避免预览后状态变化和并发超卖。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\submission.ts:202-256,303-400`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\inventory\service.ts:71-110,121-214`。
4. 金额单位为人民币分；商品金额加“每个普通包裹 1300 分”，总额必须是安全整数且不超过数据库整数上限。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\pricing.ts:1-32`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\submission.ts:303-374`。
5. 有效订单默认不含 `CANCELLED` 和 `EXPIRED`，但二者必须可按状态查询并永久保留审计历史。活动外部订单号/子订单号去重键在取消或超时后释放，允许重新导入。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\queries.ts:23-24,66-72,199-200`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\drizzle\0027_expired_order_deduplication.sql:2-34`。
6. 父单主路径：`PENDING_PAYMENT -> PAID_PENDING_FULFILLMENT -> FULFILLING -> SHIPPED`；`CANCELLED`、`EXPIRED` 为历史终态，任一普通子包裹取消或异常时父单为 `FULFILLMENT_EXCEPTION`。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\order-rollup.ts:6-24,31-52`。
7. 子包裹主路径：`PENDING -> SUBMITTING -> SUBMITTED/FULFILLING -> SHIPPED`；取消走 `CANCEL_PENDING -> CANCELLED`；异常为 `EXCEPTION`。极风状态 2 及其他非终态统一落为 `FULFILLING` 并安排下一次查询，状态 7 为已发货，8/11 为异常，9 为取消。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:143-170,287-399,411-537`。
8. 远程调用不得持有数据库事务；工作项必须使用租约、claim token 和 CAS 完成，晚到 worker 不得覆盖新 worker 或终态。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:609-681`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\feishu\outbox.ts:232-292`。
9. 客户所有订单、店铺和钱包查询必须带 `customerId`；PII 只以密文落库，并且只在服务端向极风发货时解密。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\queries.ts:45-99,152`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\identity\guards.ts:36-71`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\dispatch.ts:335-396`。

## 已确认并修复

### Important — 极风状态轮询缺少独立租约、退避和错误分层

- 触发条件：订单创建后首次查询失败；或多个 worker 同时轮询 `SUBMITTED`、`FULFILLING`、`EXCEPTION`；或状态查询连续失败。
- 原后果：重复查询、高频轮询、暂时性失败过早成为运营异常，以及旧 worker 覆盖新结果的风险。
- 修复：增加状态轮询 claim token、2 分钟租约、`FOR UPDATE SKIP LOCKED`、CAS；成功非终态每 5 分钟查询，异常每 30 分钟查询，可重试失败按 5 分钟至 6 小时指数退避；不可重试失败按 30 分钟复核；暂时性失败连续 3 次才发运营警告；终态清空 `nextRetryAt`。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:26,43-88,524-525,580-619,626-710`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\drizzle\0026_jifeng_status_poll_leases.sql:1-17`。
- 提交：`dfb05ff`。

### Important — 晚到极风状态可能回退本地终态

- 触发条件：本地已 `SHIPPED` 或 `CANCELLED` 后收到状态 2 等旧轮询/回调。
- 原后果：已发货或已取消包裹回退到履约中，父单、库存和运营展示失真。
- 修复：进入状态转换前锁定当前记录，并将 `SHIPPED` 与有效的 `CANCELLED` 作为不可回退终态。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:130-167`。
- 提交：`16486bc`。

### Important — 已取消/超时拿货单污染有效数量金额，且超时单阻止重新导入

- 触发条件：订单被取消或待付款超时后访问默认列表/客户近期汇总，或再次导入相同外部订单号。
- 原后果：经营数量和金额虚高；历史单虽无效却占用活动去重键，无法重新下单。
- 修复：默认查询排除 `CANCELLED/EXPIRED`；显式状态查询仍显示归档；UI 明确历史不计有效经营指标；数据库回填并用触发器在两类终态释放行/包裹去重键。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\queries.ts:66-72,199-200`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(admin)\admin\orders\page.tsx:77-116`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(customer)\portal\orders\page.tsx:62-65,102-125,157`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\drizzle\0027_expired_order_deduplication.sql:2-34`。
- 提交：`723e120`、`77e8dd4`、`0ad763f`。

### Important — 飞书 Outbox 的崩溃 worker 可能永久占用任务

- 触发条件：worker 将任务置为 `PROCESSING` 后崩溃，或旧 worker 在租约过期后晚到。
- 原后果：库存同步事件永久卡住；或晚到 worker 覆盖新 worker 的处理结果。
- 修复：15 分钟租约回收、每次 claim 新 UUID、最终更新同时校验事件 id、`PROCESSING` 和 claim token；晚到结果被忽略。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\feishu\outbox.ts:145-156,192-205,232-292`。
- 提交：`ae9bbd2`。

### Important — 管理页和 Server Action 泄露内部错误信息

- 触发条件：极风/数据库异常包含内部错误码、连接信息或实现细节，并被订单详情或 action toast 直接展示。
- 原后果：运营人员看到与业务不一致的内部状态（含 `MANUAL_CONFIRMED_FAILURE_RETRY`），并可能泄露数据库连接或内部诊断文本。
- 修复：只保留已文档化的极风数字业务码；内部码映射为稳定中文提示；忽略存储的原始 message；action 只透出受控领域错误。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\fulfillment-ui-labels.ts:6-82`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\actions.ts:11-26,118`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(admin)\admin\orders\[orderId]\page.tsx:112-136`。
- 提交：基线文案修复 `faad1aa`，补充安全收口 `3c0773e`。

### Moderate — 报表空态受全时段库存风险误判

- 触发条件：所选日期没有发货、补发或资金活动，但存在不受日期限制的低库存风险。
- 原后果：页面不显示“该区间无数据”空态，用户误以为日期区间有经营数据。
- 修复：日期空态只由该日期范围的经营与资金数据决定；库存风险仍独立展示。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(admin)\admin\reports\page.tsx:40-53,103-106`。
- 提交：`c2af84f`。

## 需业务决策

### Important / 上线阻断 — 子包裹独立取消缺少金额与退款状态机

- 触发条件：已付款父拿货单含多个包裹，管理员独立取消其中一个普通包裹，尤其是已进入极风后远端取消成功。
- 当前行为：只释放该包裹库存并把子包裹设为 `CANCELLED`；父单因任一取消包裹变为 `FULFILLMENT_EXCEPTION`，但订单商品金额、每包 13 元费用、付款声明、钱包扣款和结算分摊均不调整。整单取消入口又拒绝 `FULFILLING/FULFILLMENT_EXCEPTION`。
- 业务后果：客户可能为未履约商品及包裹费继续付费；财务应收、钱包余额和结算批次与实际履约不一致；全部包裹取消后父单仍可能停留异常态。
- 证据：库存/子包裹取消仅在 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\replacement.ts:243-330`；父单汇总规则在 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\order-rollup.ts:15-24`；整单取消限制与仅整单退款在 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\lifecycle.ts:435-445,527-540`；UI 允许取消任一非终态包裹在 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(admin)\admin\orders\[orderId]\page.tsx:112-155`。
- 需要决定：取消包裹是否退商品金额；是否退该包裹 13 元；钱包、线下付款和混合结算分别如何冲销；已推极风与未推极风的费用边界；全部普通包裹取消后父单进入 `CANCELLED`、`PARTIALLY_CANCELLED` 还是调整后的异常状态。
- 整改方案：确定政策后新增包裹级金额快照、退款/冲销分录和显式父单部分取消状态；用幂等键及行锁保证重复点击/回调只冲销一次；在此之前通过运营流程限制已付款包裹取消，不能宣称该流程已财务闭环。

### Moderate — “实际销售额”是否包含每包 13 元尚未明确定义

- 触发条件：查看经营报表销售额并与订单总额、收款或结算对账。
- 当前行为：报表只累加已发货普通包裹的 `order_lines.line_amount_fen`，不含 `shipping_fee_fen`，但 UI 名称为“实际销售额”。
- 业务后果：若业务把 13 元计为收入，报表会系统性低于订单/收款总额；若它是代收物流费，当前计算正确但命名仍需明确。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\reports\query.ts:30-43,53-67`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(admin)\admin\reports\page.tsx:118-130`。
- 整改方案：产品/财务确定口径；若不含物流费，将指标改名“商品销售额”并另列包裹费；若包含，按已发货包裹分摊费用且处理部分取消。

### Moderate — 极风永久失败缺少显式死信状态与处置 SLA

- 触发条件：创建结果需要人工核对，或 50026 等永久业务错误长期未处理。
- 当前行为：使用 `9999-12-31` 作为不会自动重试的时间，并保持 `FAILED/EXCEPTION`，依靠通知和人工操作识别。
- 业务后果：技术上不会重复创建，但运营指标难以区分“等待退避”和“已死信”；无法直接统计死信年龄和处置 SLA。
- 证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\dispatch.ts:584-607`。
- 整改方案：确认是否引入 `DEAD`/`MANUAL_REVIEW` 状态、最大尝试次数、告警升级和人工恢复审计；在此之前维持现有安全停重试行为。

## 测试覆盖缺口与修复

- 固定到 2026-08-20 的测试数据在当前日期自动过期，导致与业务无关的失败。已改到 2099 并补齐迁移日志断言。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\admin\bulk-workspace-queries.test.ts:36-76,121-128`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\schema\inventory-movement-listing.test.ts:275-286`。提交：`88e51b3`。
- Playwright 复用旧隔离数据库时可能缺失新字段。global setup 现在每次安全准备并迁移 E2E 数据库。证据：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\playwright.config.ts:148`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\e2e\global-setup.ts:1-3`。提交：`c2af84f`。

## 依赖与线上版本核对

- `npm audit` 报告 4 个 Moderate，根因是 `drizzle-kit -> @esbuild-kit/esm-loader -> esbuild@0.18.20` 的开发服务器跨站读取公告。锁文件把该节点标为 `devOptional`：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\package-lock.json:1532-1537,8261-8271`。自动修复要求破坏性版本变化，未盲目执行；应在独立依赖升级批次验证 `better-auth` 和 Drizzle 迁移工具后处理。
- 2026-08-20 对公开生产地址只进行了只读检查：`/api/health` 返回 200/`ok`，登录页可访问，安全响应头存在。公开健康接口按设计只返回 `ok/unavailable`：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\api\health\route.ts:9-15`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\docs\operations\production-runbook.md:69`。
- 公开接口没有可验证的 commit/image 标识，因此不能把本地 `faad1aa` 或本报告后续提交视为线上事实。发布时必须从部署平台的镜像 digest、release SHA 或日志版本字段核对实际版本。

## 验证证据

- unit：71 个文件、530 个测试通过。
- serial integration：52 个文件、385 个测试通过；使用 `--maxWorkers=1 --no-file-parallelism`。
- 相关 E2E：15/15 通过，覆盖付款、批量多店铺、极风履约、报表的桌面端与移动端。
- 定向回归：极风状态同步 13/13、极风派单 33/33、飞书 Outbox 9/9、飞书源保护 3/3、订单生命周期 9/9、订单工作台 12/12。
- `typecheck`、`lint`、Next.js 生产构建、`git diff --check` 全部通过。
- 构建使用仅用于模块解析的占位连接配置，并显式设置 `FEISHU_CARGO_WRITES_ENABLED=false`；未连接数据库。

## 路线图和发布门槛

- P0：确定子包裹取消的退款、13 元包裹费、结算冲销和父单状态政策；实现并验证包裹级财务状态机。生产迁移 0026/0027 必须先备份、预演并由发布人显式批准。
- P1：增加显式死信/人工复核状态、最大尝试次数、死信年龄指标和告警升级；在部署平台记录并可检索 release SHA/image digest。
- P2：明确报表“商品销售额/包裹费”口径；升级 `better-auth`/Drizzle 工具链并消除 esbuild 公告；补充完整父子取消 E2E 和财务对账测试。
- 上线阻断项：未确认子包裹取消财务政策；未完成生产迁移预演与备份；未核对线上镜像/commit。除此之外，本地发布候选的代码质量门禁均已通过。
