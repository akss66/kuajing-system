# 同舟行跨境 v0.2.0 生产运行手册

## 运行拓扑

- Web：Next.js 16，负责管理员后台、客户门户、Better Auth 和极风 Webhook。
- Worker：独立执行 `npm.cmd run worker`，负责待付款过期、极风推送/状态同步、飞书货盘/机器人、每日库存覆盖预警和智能 SKU 匹配记录到期清理。
- PostgreSQL 18：业务事实唯一来源，同时承载 pg-boss。Web 与 Worker 必须连接同一数据库。
- 入口代理：只开放 HTTPS 443；把 `/api/integrations/jifeng/webhook` 和其他 Web 请求转发到 Next.js。PostgreSQL 不暴露公网。

Web 与 Worker 是两个必须同时常驻的进程。只启动 Web 会导致页面可用但订单超时、极风、飞书和预警不再自动执行。

## 正式环境要求

- Node.js 24 LTS 或兼容的更高版本。
- PostgreSQL 18，启用每日备份与存储加密。
- 支持进程自动重启和日志采集的服务管理器。
- 独立的正式域名、TLS 证书和不可由开发人员共享的生产密钥管理。

环境变量以 `.env.example` 为完整清单。生产值必须存放在部署平台的 secret 管理中，不写入仓库、镜像、日志或工单。以下值上线前不可缺失：

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`（至少 32 字节随机值）
- `BETTER_AUTH_URL`（正式 HTTPS 根地址）
- `PII_ENCRYPTION_KEY`（32 字节 Base64）
- 极风全部变量和唯一加拿大邮政渠道 ID
- 飞书应用、货盘知识库节点和内部通知群变量

## 首次部署

```powershell
npm.cmd ci
npm.cmd run db:migrate
npm.cmd run build
```

全新生产数据库完成迁移后，只运行一次受控超级管理员初始化命令：

```powershell
$env:BOOTSTRAP_SUPER_ADMIN_EMAIL="admin@example.com"
$env:BOOTSTRAP_SUPER_ADMIN_DISPLAY_NAME="超级管理员"
$env:BOOTSTRAP_SUPER_ADMIN_PASSWORD="use-a-random-password"
npm.cmd run db:bootstrap-super-admin
```

该命令只允许账号表为空时创建固定的受保护超级管理员。对同一账号重复执行不会重置密码；数据库已有其他账号时会拒绝执行。生产环境仍然禁止运行 `db:seed`。

然后由服务管理器分别启动：

```powershell
npm.cmd start
npm.cmd run worker
```

部署过程中不运行 `db:seed`。首次超级管理员应通过受控运维流程创建，不能沿用本地演示密码。

## 发版顺序

1. 查看当前“系统健康”，确认没有未解释的库存、余额或履约异常。
2. 执行数据库备份，核对 `.sha256`，加密后复制到独立离机存储；保留本次对象版本/路径和失败告警证据。
3. 在预发布环境运行数据库迁移、完整测试和生产构建。
4. 以最终提交完整 SHA 设置 `RELEASE_SHA`，以前 7-40 位同一 SHA 设置 `APP_VERSION`。禁止 `current`、`latest` 或分支名。先执行 `npm.cmd run verify:release-metadata`，再用同一值构建镜像。
5. 正式环境先运行向后兼容迁移，再切换 Web，最后重启 Worker。
6. 检查 `/api/health`、镜像 OCI revision 标签、登录、报表、测试订单、极风状态和飞书同步。
7. 观察至少一个完整 Worker 周期，确认没有持续失败或积压。

数据库迁移按前向修复管理，不自动回滚 DDL。应用需要回滚时切换到上一已验证版本；若旧版本与新结构不兼容，先部署兼容补丁。只有在数据损坏且负责人批准后才从备份恢复。

## 监控与告警

> `restart: unless-stopped` 只处理进程退出，不会因为 Docker healthcheck 变成 `unhealthy` 自动替换容器。systemd watchdog 会在 Worker 缺失时按当前不可变版本单独拉起 Worker，在 Worker 明确 unhealthy 时单独重建，并等待健康后才报告成功。正式放量前必须留存两条恢复演练证据，且 PostgreSQL、Web 与 `dyflow` 容器 ID 必须保持不变。没有该证据时只能人工值守试运行，不能宣称无人值守。

- 每 30 秒请求 `GET /api/health`。连续 3 次非 200 或数据库组件为 `unavailable` 触发紧急告警；Worker 为 `missing`、`stale`、`scheduler_inactive`、`invalid` 或整体 `status=degraded` 时立即创建运维告警并检查 watchdog。响应正文只允许 `status`、`version`、`revision` 和固定枚举组件状态，不得出现文件路径、容器 ID、环境变量或内部异常文本。
- 采集 Web 与 Worker 标准输出，按进程、环境、版本和时间建立索引；日志不得采集请求体、Cookie、Authorization、收件信息或环境变量。
- 立即告警：Web/Worker 进程退出、数据库不可用、库存或余额不一致、已发货无运单。
- 5 分钟内告警：极风/飞书失败任务持续增长、处理中任务超过 10 分钟、Webhook 持续验签失败。
- 每天检查：30/40 天库存预警、待付款积压、补发异常、飞书货盘最后同步时间。
- 每周检查：系统健康、审计日志异常操作、管理员账号、备份成功率和磁盘容量。

## 备份与恢复

本地 Docker 环境可执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-postgres.ps1 `
  -DatabaseName tongzhouxing `
  -OutputDirectory .\backups
```

恢复只允许进入已显式创建且完全为空的目标库，并必须带确认开关：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-postgres.ps1 `
  -BackupFile C:\secure-backups\tongzhouxing-production.dump `
  -TargetDatabaseName tongzhouxing_restore_validation `
  -ConfirmRestore
```

恢复脚本会在写入数据库前强制验证同名 `.sha256`，且不会清空或覆盖已有表。生产必须每天一份自定义格式备份，至少保留 30 天；备份离机、加密并限制读取权限。每月至少在隔离库恢复一次并核对关键表行数、最近订单和加密收件信息。仓库脚本不能证明云对象锁、加密密钥、告警或恢复演练已经配置，所需证据见 [发布门禁](release-gates.md)。

正式 Linux 服务器可安装 systemd 定时任务：

```bash
sudo install -m 0755 scripts/backup-production.sh /usr/local/lib/tongzhouxing-shop/backup-production.sh
sudo install -m 0644 deploy/systemd/tongzhouxing-shop-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/tongzhouxing-shop-backup.timer /etc/systemd/system/
sudo install -d -m 0750 /var/backups/tongzhouxing-shop
# /etc/tongzhouxing-shop/backup.env 至少固定以下四项：
# COMPOSE_FILE=/absolute/release/compose.production.yaml
# COMPOSE_ENV_FILE=/absolute/secrets/.env.production
# BACKUP_DIR=/var/backups/tongzhouxing-shop
# RETENTION_DAYS=30
# CATALOG_ASSETS_VOLUME=tongzhouxing_shop_catalog_assets
# APP_VERSION=<当前发布 Git SHA 前 7 位>
# RELEASE_SHA=<当前发布完整 40 位 Git SHA>
sudo systemctl daemon-reload
sudo systemctl enable --now tongzhouxing-shop-backup.timer
systemctl status tongzhouxing-shop-backup.timer --no-pager
journalctl -u tongzhouxing-shop-backup.service -n 50 --no-pager
```

每次成功会在备份目录原子发布一个 `backup-set-<UTC 时间>` 子目录；只有数据库备份、商品图归档及两份 SHA-256 都成功后才会出现 `.complete` 标记。失败的暂存目录会自动清理，不得把缺少 `.complete` 的目录当作可恢复备份。

## 密钥轮换与事件处理

- 极风/飞书 token 或 secret 泄露：先在第三方平台吊销，再更新 secret 管理并重启 Web/Worker；检查集成尝试和审计日志。
- `BETTER_AUTH_SECRET` 轮换会使现有会话失效，应提前通知用户并在低峰执行。
- `PII_ENCRYPTION_KEY` 不能直接替换，否则历史收件信息无法解密。轮换必须实现双密钥读取和重新加密迁移后再移除旧密钥。
- 发生疑似隐私泄露时立即停止相关日志/导出、保全审计证据并按适用法规和合同启动事件响应。

## 上线后验收

- `/api/health` 返回 200、`status=ok`、数据库与 Worker 均为 `healthy`，且 `version`/`revision` 与部署的最终 Git SHA 和镜像 OCI 标签一致。
- 超级管理员和客户均能登录，客户无法访问 `/admin`。
- 有余额拿货单自动扣款；余额不足订单等待线下核款；过期订单释放库存。
- 普通包裹与补发只在极风已发货后扣库存，重复事件不重复扣减。
- 飞书货盘来自数据库，系统和飞书群都能收到异常与库存覆盖预警。
- 报表按多伦多自然日显示 SKU、店铺、补发和人民币资金数据。
- 360/390/430px 手机和桌面关键流程无阻断。
