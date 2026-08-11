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
