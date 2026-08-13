# 同舟行跨境本地开发手册

## 环境要求

- Node.js 24 或更高版本
- Docker Desktop（PostgreSQL 18）
- Windows PowerShell
- 本地不需要额外安装系统字体。`npm.cmd install` 会把 `@fontsource-variable/geist` 和 `@fontsource-variable/noto-sans-sc` 装入项目，Web 与截图测试统一使用仓库内字体资源。

## 首次启动

```powershell
Copy-Item .env.example .env.local
docker compose up -d postgres
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

另开一个终端启动后台任务：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run worker
```

打开 `http://127.0.0.1:3000`。本地种子账号：

- 超级管理员：`admin@tongzhouxing.local` / `TongZhouXing-Admin-2026!`
- 客户：`customer@tongzhouxing.local` / `TongZhouXing-Customer-2026!`

`db:seed` 只用于本地演示。生产环境禁止运行种子。当前种子流程只会创建一个受保护的 bootstrap 超级管理员；普通管理员必须通过系统账号管理创建，且不能升级为新的超级管理员。

## 数据库与迁移

修改 `src/db/schema` 后执行：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run db:generate
npm.cmd run db:migrate
```

v0.2.0 之后，本地库至少要包含以下前向迁移：

- `0010_multi_store_bulk_order`：多店批量草稿、店铺分组、统一结算批次、钱包冻结与 24 小时草稿生命周期索引。
- `0011_bulk_submission_requests`：批量提交幂等请求表，避免重复提交生成重复扣款或重复锁库。
- `0012_settlement_timeout_review`：统一结算付款声明的超时拒绝与原子释放。
- `0013_jifeng_reconciliation_claim`：极风履约对账 claim token 与 `(target, status, locked_at)` 租约索引，支持崩溃后的安全回收。
- `0014_account_governance`：受保护超级管理员、客户一对一账号约束和脏数据预检。

集成测试始终强制连接数据库名包含 `test` 的测试库，防止测试清理开发库或生产库。

## Worker 与超时行为

`npm.cmd run worker` 是本地完整流程的一部分，不是可选项。它负责：

- 每分钟释放待付款超时订单的库存锁定。
- 每分钟将待审核统一结算批次推进到超时拒绝，并原子释放钱包冻结。
- 每分钟处理极风推单、对账重试与状态同步。
- 每分钟处理飞书货盘与内部通知队列。
- 每天按多伦多时区 09:00 生成库存覆盖预警。

批量草稿本身不靠后台 worker 清理。草稿与其导入文件在领域服务读写时按 24 小时 TTL 判定过期，过期后保留只读诊断，不允许继续上传、删文件或再次提交。

极风对账使用租约回收策略：`integration_outbox.claim_token` 持有当前处理 owner，`locked_at` 超过租约后才允许新 worker 接管；接管前先查单再决定是否重建，避免重复创建极风单。

## 本地构建与环境变量

`.env.example` 是完整变量清单。以下变量在本地 `build`、`dev`、`worker` 或验收命令中必须存在：

- `DATABASE_URL`
- `TEST_DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `PII_ENCRYPTION_KEY`

`next build` 会经过需要数据库和认证配置的路由与模块导入，因此不能在缺少这些变量时运行。开发环境可保持 `BETTER_AUTH_URL=http://localhost:3000` 或 `http://127.0.0.1:3000`；正式环境必须改为 HTTPS 根地址。

## 极风与飞书联调

正式联调前，在 `.env.local` 配齐 `.env.example` 中的极风和飞书变量，然后同时运行 Web 与 Worker。所有密钥只允许保存在服务端环境变量，后台系统集成页只显示“已配置/未配置”。

极风侧需要确认：API 域名、client id/secret、access/refresh token、user id、加拿大仓库编号，以及唯一使用的加拿大邮政渠道 ID。Webhook 地址为：

```text
https://你的正式域名/api/integrations/jifeng/webhook
```

飞书侧需要创建企业自建应用并开通知识库、电子表格与群消息权限；将应用添加为“同舟行跨境加拿大飞书货盘”的 source wiki 协作者，并为 target 测试表单独准备 `FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN` 与 `FEISHU_CARGO_TARGET_SHEET_ID`。这两个 target 变量必须成对出现或同时缺失；仅配置 `FEISHU_CARGO_SOURCE_WIKI_TOKEN`（以及可选的 `FEISHU_CARGO_SOURCE_SHEET_ID`）时只允许预检，不会执行货盘写入。机器人通知仍需把机器人加入内部通知群并配置 `FEISHU_INTERNAL_CHAT_ID`。

联调顺序：

1. 在“系统设置 -> 外部集成”确认极风和飞书都显示已配置。
2. 先执行飞书连接测试，再手动触发一次货盘同步，确认表头和 SKU 数据正确。
3. 用测试订单完成“付款 -> 推送极风 -> 极风已发货”，确认运单号、加拿大元运费和库存扣减各只发生一次。
4. 验证普通包装与补发包裹的取消、异常与重试通知同时出现在系统通知和飞书内部群。

没有正式凭证时，极风和飞书任务会安全停用，不影响本地订单、库存和支付流程；自动化测试使用可控模拟服务，不会请求真实第三方接口。

## 验收命令

完整 gate 建议按以下顺序串行执行，尤其是集成测试和 E2E 共用 PostgreSQL 时不要并行：

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run test:e2e -- --workers 1
```

任何一项失败都不能视为验收通过。视觉快照只在人工检查新截图后使用 `--update-snapshots` 更新。

## 数据库重置

仅在确认不需要保留本地开发数据时执行：

```powershell
docker compose down
docker volume rm kuajinng_tongzhouxing_postgres_data
docker compose up -d postgres
npm.cmd run db:migrate
npm.cmd run db:seed
```

命令中的卷名必须先通过 `docker volume ls` 核对，不要对未知卷执行删除。

## 安全规则

- `.env.local`、真实 API 密钥、飞书凭证和客户数据不得提交到 Git。
- 金额以人民币分整数保存，库存以件数整数保存。
- 所有库存、价格、客户和订单状态变更必须走领域服务并写审计记录。
- 本地演示数据必须是虚构数据，不得导入真实消费者姓名、地址或联系方式。
