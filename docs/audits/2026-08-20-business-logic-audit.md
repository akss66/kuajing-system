# 跨境系统业务逻辑与安全审计（2026-08-20）

> 2026-08-21 接续更新：极风履约已经改为只按 `platformOrderNo` 匹配已有订单，创建接口和旧创建执行器均已删除。本文中关于“创建/重建极风订单”的历史描述不再代表当前实现；现行决策见 `docs/decisions/001-jifeng-existing-order-match-only.md`。

## 范围与最终结论

- 接续基线：`codex/sku-management` / `faad1aa21dc94f6c6ad04234695ae19ce15468e6`；本轮独立 worktree 分支为 `codex/sku-management-audit-20260820`。
- 审计范围：飞书货盘、商品/SKU、库存与流水、TEMU 导入、金额与结算、极风履约、Outbox、权限、PII、异常恢复、报表、Worker 与测试隔离。
- 本地发布候选已修复本轮确认的 Critical/Important/Moderate 代码缺陷；fresh-context 逆向复核在正确 worktree 上未发现剩余代码阻断缺陷。
- 截图中的“极风状态 9 已取消，但父拿货单一直显示仓库处理异常且没有恢复入口”已修复：管理员可“重新核对取消状态”，系统幂等修复父单、库存释放标记和取消金额调整，不会重新创建极风订单。
- 本轮没有部署、没有执行线上迁移、没有重启线上容器、没有写线上业务数据。测试环境页面仍可能是旧版本，不能把本地结果当作线上事实。

## 已确认的业务不变量

1. 拿货单只是“一家店铺一次导出的订单集合”和历史容器；原始金额永久保留。普通子包裹是库存、履约、取消和退款的最小业务单元。
2. 当前净额 = 原始拿货单金额 - 已确认的子包裹取消调整；取消调整包含该包裹商品金额与每包 `1300` 分物流费。固定费定义见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\pricing.ts:1`，净额查询见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\queries.ts:39`。
3. 未付款包裹取消冲减应付；已付款包裹取消形成钱包退款和/或待完成线下退款。调整必须有唯一包裹键并幂等，实现入口见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\package-cancellation-adjustment.ts:138`。
4. 统一结算 `PENDING_PAYMENT` 遇到包裹取消时，旧报价作废并释放整笔钱包占用；`PAYMENT_REPORTED` 的运营主动取消必须先撤回整笔付款声明。极风已返回权威状态 9 时不能拒绝事实同步，但旧付款审核必须被阻止并转人工整批对账，见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\settlement\batch-service.ts:304`、`:423`、`:841`。
5. 父单保留原历史，取消汇总为 `NONE/PARTIAL/ALL`；全部普通包裹取消后父单为 `CANCELLED`，部分取消保留可识别的异常/部分取消状态，父单汇总见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\order-rollup.ts:31`。
6. 飞书源货盘只读；发布配置强制 `FEISHU_CARGO_WRITES_ENABLED=false`，见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\compose.production.yaml:14`。数据库是商品、库存、订单与金额的唯一事实来源。
7. SKU 匹配优先级为“店铺专属映射 > 全局映射 > 在售标准 SKU 精确码”；同一平台主订单收件信息冲突必须整包无效，不能选择最后一行地址。
8. 活动去重键同时覆盖 `storeId + externalOrderNo` 和 `storeId + externalSubOrderNo`；单店和批量路径共享同一 advisory-lock 命名空间，定义见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\import-conflict-lock.ts:13`。
9. 极风状态 2 为“待仓库发货/履约中”，7 为已发货，8/11 为仓库异常，9 为已取消；首次绑定必须按平台订单号精确匹配已有订单，绑定后的查询和取消必须按极风真实 ERP 单号关联，不能用一个包裹的响应更新另一个包裹。
10. 远程调用不得占用长数据库事务；轮询、Outbox 使用 claim token、租约、`SKIP LOCKED` 和 CAS。成功查询必须清理失败计数与 claim，并按状态重新安排或清空 `nextRetryAt`。
11. 客户数据访问以认证主体 `customerId` 为边界；账号创建/停用属于超级管理员能力；联系人姓名和微信号不得明文复制到审计日志。

## 已确认并修复

### Critical — 子包裹取消后的金额、退款、结算和库存闭环

- 触发：任一普通包裹在未付款、钱包/线下混合付款、统一结算或极风已接单后被取消。
- 原后果：可能只释放库存而不退商品金额和 ¥13，订单、钱包、结算和报表继续使用取消前金额。
- 修复：新增包裹取消调整表、订单取消汇总、钱包包裹退款与线下退款完成状态；原始金额不变，所有客户/管理员列表和详情读取当前净额；重复点击、重复状态 9 只应用一次。迁移见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\drizzle\0028_package_cancellation_adjustments.sql:1`，领域实现见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\package-cancellation-adjustment.ts:138`，回归见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\fulfillment\package-refund.test.ts:1`。

### Important — 截图所示极风异常没有可恢复路径

- 触发：极风已接单后查询异常；极风实际状态已经恢复为 2；或极风已是 9，但本地父单仍是 `FULFILLMENT_EXCEPTION`。
- 原后果：页面永久显示“仓库处理异常”，运营只有危险的“重试创建”，没有可信的状态重查/自愈入口。
- 修复：新增管理员手动状态查询，支持 `SUBMITTED/FULFILLING/EXCEPTION/CANCELLED/SHIPPED`，使用 2 分钟租约和 CAS，严格校验响应 ERP 单号；存在远端提交证据的异常只重查状态，绝不重新调用 CREATE_ORDER。域入口见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:621`，安全 Action 见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\actions.ts:135`，页面入口见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\app\(admin)\admin\orders\[orderId]\page.tsx:206`。
- 重复状态 9 以包裹取消调整记录作为副作用标记，并重新计算父单；不再依赖父单当前状态，见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:179`。

### Important — 极风轮询、错误分类和响应关联

- 触发：首次查询失败、长期状态 2、状态 8/11、永久错误、多个 worker 或极风返回不匹配 ERP 单号。
- 原后果：高频轮询、过早展示运营异常、永久错误反复调用、旧 worker 覆盖新结果，甚至更新错误包裹。
- 修复：正常状态 5 分钟、异常 30 分钟；临时失败从 5 分钟起指数退避、最长 6 小时，连续三次才通知；永久错误停放；查询成功清空失败状态；轮询和创建结果都校验 ERP 单号。退避上限见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:29`，关联校验见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\status-sync.ts:696`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\dispatch.ts:732`。

### Important — 导入一致性、并发与取消后重新导入

- 触发：同一 Excel 重复子订单、同主订单多商品行、冲突收件人、两个预览并发提交、single/bulk 跨路径竞争、活动主订单配新子单、取消后重导。
- 原后果：同文件重复成单、随机 PII 密文造成合法混装误判、最后一行覆盖地址、原始 23505 暴露、恢复导入假可用。
- 修复：同文件首条 READY 后续 DUPLICATE；同包同收件人复用同一密文信封；冲突收件人整包 INVALID；预览与提交同时检查主/子订单号；single/bulk 使用同一排序 advisory locks；包裹取消只释放该包裹及其行的去重键。锁定义见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\orders\import-conflict-lock.ts:13`，预览主订单检查见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\order-import\service.ts:158`，取消去重释放见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\package-cancellation-adjustment.ts:180`。

### Important — 账号治理旁路与审计 PII

- 触发：普通管理员通过客户管理 Action 创建客户登录账号、停用账号/撤销会话，或修改联系人姓名/微信号。
- 原后果：绕过超级管理员边界；PII 被长期复制到审计表。
- 修复：公开 Action 与服务层双重校验超级管理员；普通管理员仍可维护客户资料和店铺，但看不到账号治理控件；审计 before/after 使用姓名和微信脱敏。Action 见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\customers\actions.ts:172`、`:320`，PII 处理见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\customers\service.ts:167`。

### Important — 资金与经营报表口径不一致

- 触发：统一结算线下付款获批、包裹线下退款完成、部分取消，或查看含未付款订单的 Dashboard。
- 原后果：到账漏计、退款漏计、待付款高估，并把“已下单未付款金额”误称 GMV/成交金额。
- 修复：资金报表合并单单付款和统一结算付款，单列已完成线下退款；客户管理使用取消后净额；Dashboard 改称“下单净额”；商品销售额明确不含物流费。资金合并见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\reports\query.ts:22`、`:182`，净额见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\customers\queries.ts:165`。

### Important — Worker 与 Outbox 静默停止/无限重试

- 触发：Worker 初始化卡住、队列 worker 消失、事件循环长期阻塞，或飞书 Outbox 持续失败。
- 原后果：自动取消、付款超时、极风派单/轮询、飞书通知全部静默停止；飞书失败任务永久重试。
- 修复：Worker 写入 0600 原子心跳，区分 STARTING/READY/DEGRADED/STOPPING，检查核心队列活跃度；Compose 启用无端口 healthcheck。Outbox 最多 8 次，之后永久停放并生成仅站内通知，避免通知递归。Worker 检查见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\jobs\worker-health.ts:56`，Compose 见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\compose.production.yaml:94`，Outbox 见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\feishu\outbox.ts:43`、`:192`。

### Moderate — UI 内部错误码与测试数据库破坏风险

- 极风手动查询错误已按 code 映射固定中文，不再透传 `PENDING/SUBMITTING/CANCEL_PENDING` 等内部枚举，见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\src\modules\fulfillment\actions.ts:41`、`:162`。
- Integration 不再回退调用者 `DATABASE_URL`；无 `TEST_DATABASE_URL` 时自动创建并最终删除独立本机库。显式复用现有库必须同时满足本机、`*_test` 名称和 `ALLOW_EXISTING_TEST_DB_RESET=true`，且 truncate 前二次核对 `current_database()`。环境门禁见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\database-environment.ts:14`、`:31`，删除/迁移见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\global-setup.ts:8`，truncate 门禁见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\tests\integration\setup.ts:8`。

## 反证后未确认的问题

- 没有确认 `customerId` IDOR：订单、钱包、结算与导入服务均从认证主体取得客户边界；共享货盘是当前业务模型，不是租户泄露。
- 没有确认“状态 2 会一直高频轮询”：成功状态 2 按 5 分钟安排，异常 8/11 按 30 分钟，失败按指数退避。
- 没有确认“状态查询成功后残留 nextRetryAt/失败计数”：成功路径统一清空失败字段、claim 与失败计数，并按终态清空或按非终态重排。
- 没有确认“父单异常阻止兄弟包裹继续派单”：派单以每个子包裹状态为准；父单异常是聚合展示，不是全单锁死。
- 没有确认“取消包裹后仍永久占用主/子订单号”：取消调整事务已仅关闭该 shipment/lines 的活动去重键，兄弟包裹保持活动。

## 仍需业务决策（不是本轮可擅自修改的缺陷）

- 角色模型：是否增加运营、财务、仓库角色和大额钱包/付款双人复核；当前只收紧了已存在的超级管理员账号治理边界。
- 定价：当前所有客户共用 SKU 拿货价，`customer_sku_prices` 尚未形成客户等级价/协议价/促销价优先级；¥13 仍是明确固定规则，未来变化需要带生效时间的版本化策略。
- 账号：当前一个客户一个登录账号；老板、运营、财务、分店协作需要新的客户成员与店铺授权模型。
- 财务：微信线下付款仍以金额和备注为主；付款截图、流水号、付款人、重复付款识别、自动对账、月结、税费、汇率和利润口径属于后续财务产品设计。
- 售后：本轮闭合了取消退款和补发，但退货入库、报废、物流索赔、责任归属与成本追回仍需独立状态机。
- 极风显式死信：当前用永久 `nextRetryAt` + ERROR 通知安全停放；是否新增 `DEAD/MANUAL_REVIEW`、SLA 和升级告警需要运营口径。

## 验证证据

- Unit：73 个文件、557/557；新增数据库门禁和安全文案定向 13/13。
- Serial integration：53 个文件、422/422；自动创建、迁移并清理独立本机数据库。另用恶意调用者 `DATABASE_URL` 验证其被忽略。
- 相关 E2E：18/18，覆盖付款、包裹取消退款、补发、报表、多店铺导入、极风连接和移动端。
- `typecheck`、`eslint --quiet`、Next.js 16.3 production build、`docker compose config --no-interpolate`、`git diff --check` 全部通过。
- `npm audit`：0 Critical、0 High、4 Moderate；均来自开发依赖 `drizzle-kit -> @esbuild-kit -> esbuild`。自动建议会破坏性降级 Drizzle，未执行 `--force`。
- fresh-context 逆向审查第一轮因误读原工作区而作废；纠正到本 worktree 后确认旧金额、status 9 幂等、取消后重导和 externalOrderNo 四项均已修复。其发现的测试库复用门禁和状态码文案两项也已 RED→GREEN 收口，最终无剩余代码阻断项。

## P0 / P1 / P2 与发布阻断

### P0（正式生产前）

- 在真实测试凭证下完成极风/飞书 UAT：正常单、多包裹部分成功、状态 2、50019、50026、自备包装、超时、重复派单、取消/发货竞态、补发、重复回调、Token 失效与刷新。代码测试不能替代第三方真实验收。
- 把数据库和商品图片备份真正接入定时任务、异地加密保存、失败报警与恢复演练。当前只有脚本/文档：`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\scripts\backup-postgres.ps1:1`、`C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\docs\operations\backup-restore-drill-2026-08-12.md:1`。
- 给 Worker unhealthy 接入外部告警和自动恢复。Compose `restart: unless-stopped` 不会因为容器仅变成 unhealthy 就自动重启；本轮探针解决“看不见”，不等于完成自愈。
- 明确发布 SHA、迁移 0028、回滚步骤与镜像 digest；先备份、在副本预演迁移，再由发布人显式批准。`package.json` 仍为 `0.1.0`，见 `C:\Users\AKSSINA\.codex\worktrees\sku-audit-20260820\kuajinng\package.json:3`。

### P1

- 实施运营/财务/仓库职责分离与高风险双人复核。
- 建立死信年龄、Worker 心跳、极风失败分类、Outbox 堆积、备份失败和磁盘/内存告警。
- 完成线下付款凭证、重复付款识别与对账工作台。

### P2

- 客户成员/分店权限、客户分层定价与版本化物流费。
- 仓库/库位/批次/采购入库/成本层，以及完整退货、索赔、报废流程。
- 在独立依赖升级批次处理 Drizzle 开发工具链的 4 个 Moderate 公告。

### 当前发布判断

- 本地代码门禁：通过。
- 部署到现有测试环境：需要用户明确授权；本轮未部署。
- 转为无人值守正式生产：仍被真实第三方 UAT、自动备份/恢复、Worker 告警/自愈和发布版本治理阻断。
- “服务器仅 3.4GiB、剩余约 12GB”的外部结论本轮未重新读取服务器，因此标记为待现场复核，不能当作本地代码事实。
