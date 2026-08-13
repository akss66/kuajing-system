# 同舟行跨境

面向加拿大 TEMU 一件代发业务的拿货、库存、人民币结算、极风履约与飞书货盘系统。当前版本为 `v0.1.0`，数据库是库存、订单、资金和履约的唯一事实来源，飞书货盘作为自动同步的对外展示。

## 已实现

- 超级管理员与固定合作客户登录、客户/店铺权限隔离
- 商品、SKU、客户价、SKU 别名、货盘库存与完整库存流水
- TEMU 原始 Excel 预览、重复/未知 SKU 校验、拿货单提交
- 余额自动扣款、线下微信付款申报/核款、2 小时与 12 小时锁库释放
- 极风幂等推单、状态/Webhook、加拿大邮政运单与费用、取消和补发
- 普通包裹与补发仅在极风已发货后扣库存
- 飞书货盘同步、系统通知与飞书机器人异常/库存预警
- 多伦多自然日 SKU、店铺、补发、人民币资金报表
- 7 日出库速度对应的 40/30 天库存覆盖预警
- 审计、隐私脱敏、系统健康、安全响应头、备份恢复与上线手册
- 浅色桌面后台与 360/390/430px 手机适配

## 本地启动

要求 Node.js 24、Docker Desktop 和 PowerShell。

```powershell
Copy-Item .env.example .env.local
docker compose up -d postgres
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

另开终端启动常驻任务：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run worker
```

打开 `http://127.0.0.1:3000`。本地演示账号和完整命令见 [本地开发手册](docs/operations/local-development.md)。

## 验证

```powershell
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

## 文档

- [生产运行手册](docs/operations/production-runbook.md)
- [飞书货盘迁移上线手册](docs/operations/feishu-cargo-migration.md)
- [备份恢复演练](docs/operations/backup-restore-drill-2026-08-12.md)
- [v0.1.0 版本说明](docs/releases/v0.1.0.md)
- [产品定义](PRODUCT.md)
- [设计系统](DESIGN.md)

正式联调仍需由业务方提供极风正式 API 凭证、加拿大仓库/加拿大邮政渠道 ID，以及飞书自建应用与文档/群权限。未配置时外部任务会安全停用，本地业务功能和模拟验收不受影响。
