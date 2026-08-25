# v0.2.0 发布门禁与外部证据

本文件区分“仓库可自动验证”和“必须由正式基础设施提供”的事实。未提供外部证据时，不得把功能存在等同于生产保障已经启用。

## 仓库自动门禁

GitHub Actions `Release gates` 对每个 PR 及 `main`、`codex/**` 推送执行：

- `npm ci` 锁定依赖；
- unit、typecheck、lint、`diff-check`、production/full dependency audit、Next production build；
- PostgreSQL 18 中自动创建、迁移、串行执行并删除独立 integration 测试库；
- 独立 E2E 测试库、桌面与移动端完整 Playwright；失败时上传报告和 trace；
- 保存与提交 SHA 绑定的 Next build identity。

GitHub 仓库管理员仍需把三个 job 设为 `main` 分支 required checks，并禁止 force-push。仅提交 workflow 文件无法证明分支保护已在 GitHub 端启用。

## 不可变发布身份

生产镜像只接受：

- `APP_VERSION`：当前提交 7-40 位小写 Git SHA；
- `RELEASE_SHA`：同一提交完整 40 位小写 Git SHA；
- `package.json`：产品版本 `0.2.0`。

`npm.cmd run verify:release-metadata` 会拒绝 `current`、`latest`、版本号或互不匹配的 SHA。Docker 镜像和容器写入 OCI `version`/`revision` 标签。部署后必须保存以下只读证据：

```powershell
docker image inspect "tongzhouxing-shop:$env:APP_VERSION" `
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
docker compose -f .\compose.production.yaml ps
Invoke-RestMethod https://shop.tzxai.top/api/health
```

健康响应只公开 `status`、`version`、`revision` 和固定枚举的 `components.database`/`components.worker`，不返回文件路径、容器 ID、异常文本或环境变量。必须核对响应、镜像 OCI 标签、容器环境三者一致，不能只根据镜像 tag 推断正在运行的版本。`status=degraded` 会保持 HTTP 200 以避免把仍可服务的 Web 一并标成 unhealthy；外部监控必须解析正文并对 `degraded` 告警。

## Worker 自动替换单元

仓库提供 `scripts/worker-watchdog.sh` 和 `deploy/systemd/tongzhouxing-worker-watchdog.*`。脚本在 `worker` 容器缺失时用当前不可变镜像执行 `up -d --no-build --no-deps worker`，在现有容器明确为 `unhealthy` 时只对 Worker 执行 `--force-recreate`；两条恢复路径都必须等待新容器进入 `healthy` 才成功。`healthy`/`starting` 不操作，未知状态只报错，绝不启动、重启或停止 Web 与 PostgreSQL。

安装仍是正式服务器状态变更，必须在部署窗口由运维执行并留存输出：

```bash
sudo install -m 0755 scripts/worker-watchdog.sh /usr/local/lib/tongzhouxing-shop/worker-watchdog.sh
sudo install -m 0644 deploy/systemd/tongzhouxing-worker-watchdog.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/tongzhouxing-worker-watchdog.timer /etc/systemd/system/
# /etc/tongzhouxing-shop/watchdog.env 固定以下四项：
# COMPOSE_FILE=/absolute/release/compose.production.yaml
# COMPOSE_ENV_FILE=/absolute/secrets/.env.production
# APP_VERSION=<当前提交 7-40 位 Git SHA>
# RELEASE_SHA=<同一提交完整 40 位 Git SHA>
sudo systemctl daemon-reload
sudo systemctl enable --now tongzhouxing-worker-watchdog.timer
sudo systemctl start tongzhouxing-worker-watchdog.service
systemctl status tongzhouxing-worker-watchdog.timer --no-pager
journalctl -u tongzhouxing-worker-watchdog.service -n 50 --no-pager
```

watchdog 会校验并导出 `APP_VERSION`/`RELEASE_SHA`，覆盖 `COMPOSE_ENV_FILE` 中可能遗留的可移动旧标签；四项必须由每次部署原子更新。只有分别完成“删除测试 Worker 后自动按不可变版本拉起”和“让测试 Worker 进入 unhealthy 后只替换 Worker 容器 ID”两次演练，并证明 Web、PostgreSQL 与其他项目容器 ID 均未变化，才算自动恢复门禁通过。

## 正式设施阻断项

以下每项必须给出时间、负责人、目标环境和可复核输出：

1. 外部 HTTP 监控每 30 秒检查 Web；连续 3 次失败告警。
2. Worker `unhealthy` 自动替换演练；证明只重建 Worker，不重启 PostgreSQL/Web/其他项目。
3. 每日备份任务的最近 7 次结果、失败告警、SHA-256、加密方式和离机对象版本/对象锁。
4. 最近 30 天内的隔离恢复演练；逐表核对关键行数、最近订单，并验证当期 PII 密钥可解密测试记录。
5. 发布前回滚演练或已验证的上一镜像 SHA；禁止使用可移动标签回滚。
6. 日志采集能按 `RELEASE_SHA` 查询 Web/Worker，且不采集 Cookie、Authorization、请求体、收件信息或环境变量。

只要 1-6 任一项缺失，本版本最多进行人工值守试运行，不满足无人值守正式放量条件。
