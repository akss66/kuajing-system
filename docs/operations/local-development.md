# 同舟行跨境本地开发手册

## 环境要求

- Node.js 24 或更高版本
- Docker Desktop（PostgreSQL 18）
- Windows PowerShell

## 首次启动

```powershell
Copy-Item .env.example .env.local
docker compose up -d postgres
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

另开一个终端启动后台任务。待付款订单超时释放库存依赖该常驻进程：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run worker
```

打开 `http://127.0.0.1:3000`。本地种子账号：

- 管理员：`admin@tongzhouxing.local` / `TongZhouXing-Admin-2026!`
- 客户：`customer@tongzhouxing.local` / `TongZhouXing-Customer-2026!`

以上账号只允许用于本地开发，生产环境禁止运行 `db:seed`。

## 数据库与迁移

修改 `src/db/schema` 后执行：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run db:generate
npm.cmd run db:migrate
```

集成测试始终强制连接数据库名包含 `test` 的测试库，防止测试清理生产或开发数据。

## 极风与飞书联调

正式联调前，在 `.env.local` 配齐 `.env.example` 中的极风和飞书变量，然后同时运行 Web 与常驻任务进程。所有密钥只允许保存在服务端环境变量，后台系统集成页只显示“已配置/未配置”。

极风侧需要确认：API 域名、client id/secret、access/refresh token、user id、加拿大仓库编号，以及唯一使用的加拿大邮政渠道 ID。Webhook 地址为：

```text
https://你的正式域名/api/integrations/jifeng/webhook
```

飞书侧需要创建企业自建应用并开通知识库、电子表格与群消息权限；将应用添加为“同舟行跨境加拿大飞书货盘”知识库或电子表格协作者，并把机器人加入内部通知群。`FEISHU_CARGO_SHEET_ID` 可留空，由系统选择工作表中的第一张表；有多张表时必须填写明确的 sheet id。

联调顺序：

1. 在“系统设置 → 外部集成”确认两项均显示已配置。
2. 先执行飞书连接测试，再手动触发一次货盘同步，确认表头和 SKU 数据正确。
3. 用测试订单完成“付款 → 推送极风 → 极风已发货”，确认运单号、加拿大元运费和库存扣减各只发生一次。
4. 验证普通包裹与补发包裹的取消、异常与重试通知同时出现在系统通知和飞书内部群。

没有正式凭证时，极风和飞书任务会安全停用，不影响本地订单、库存和支付流程；自动化测试使用可控模拟服务，不会请求真实第三方接口。

## 质量检查

```powershell
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
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

命令中的卷名必须先通过 `docker volume ls` 核对；不要对未知卷执行删除。

## 安全规则

- `.env.local`、真实 API 密钥、飞书凭证和客户数据不得提交到 Git。
- 金额以人民币分整数保存，库存以件数整数保存。
- 所有库存、价格、客户和订单状态变更必须走领域服务并写审计记录。
- 本地演示数据必须是虚构数据，不得导入真实消费者姓名、地址或联系方式。
