# 飞书货盘迁移上线手册

日期：2026-08-13  
适用范围：`tongzhouxing-shop` 生产环境首批飞书货盘迁移  
当前阶段：Phase A 只允许部署、连接验证、只读预检和证据记录；**不允许确认导入，不允许写测试表，不允许改写原业务货盘**

## 1. 操作边界

- 服务边界：`web`、`worker`、`postgres`、`tongzhouxing_shop_catalog_assets` 卷。
- 数据边界：原业务飞书货盘只读；PostgreSQL 是导入目标；独立测试表只作为后续镜像展示目标。
- 控制边界：只有超级管理员可以执行首批预检和确认；Phase A 到本文档的“停止点”为止。

## 2. 变更前提

- 已准备一个**独立空白**飞书电子表格，名称固定为 `同舟行系统货盘测试表`。
- 已把飞书应用 `同舟行跨境货盘同步` 添加为该测试表的可编辑协作者。
- 已拿到：
  - `FEISHU_APP_ID`
  - `FEISHU_APP_SECRET`
  - `FEISHU_CARGO_SOURCE_WIKI_TOKEN`
  - `FEISHU_CARGO_SOURCE_SHEET_ID`
  - `FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN`
  - `FEISHU_CARGO_TARGET_SHEET_ID`
- 已确认源 wiki token 与目标 spreadsheet token 不同；若相同，立即停止。
- 已安排 10 到 20 分钟业务冻结窗口，用于最终只读复检和后续单独审批。

## 3. 密钥录入

在生产主机使用**交互式编辑器**写入 `/home/admin/tongzhouxing-shop/.env.production`。不要把密钥放到 shell 历史、工单、聊天或截图中。

```bash
cd /home/admin/tongzhouxing-shop
cp -n .env.example /home/admin/tongzhouxing-shop/.env.production
nano /home/admin/tongzhouxing-shop/.env.production
```

必须填写或核对：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_CARGO_SOURCE_WIKI_TOKEN=
FEISHU_CARGO_SOURCE_SHEET_ID=
FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN=
FEISHU_CARGO_TARGET_SHEET_ID=
CATALOG_ASSET_DIR=/app/data/catalog-assets
```

保存后只做最小校验：

```bash
grep -E '^(FEISHU_APP_ID|FEISHU_CARGO_SOURCE_WIKI_TOKEN|FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN|CATALOG_ASSET_DIR)=' /home/admin/tongzhouxing-shop/.env.production
```

注意：上面的校验只确认键存在，不应回显真实 secret。

## 4. 发布前备份

先备份数据库，再备份图片卷。以下命令在生产主机执行：

```bash
cd /home/admin/tongzhouxing-shop
export APP_ENV_FILE=/home/admin/tongzhouxing-shop/.env.production
export BACKUP_DIR=/home/admin/backups/feishu-cargo-migration
export BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d postgres
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges \
  > "$BACKUP_DIR/postgres-$BACKUP_STAMP.dump"
docker run --rm \
  -v tongzhouxing_shop_catalog_assets:/from \
  -v "$BACKUP_DIR":/to \
  alpine sh -c "cd /from && tar -czf /to/catalog-assets-$BACKUP_STAMP.tar.gz ."
ls -lh "$BACKUP_DIR"/postgres-"$BACKUP_STAMP".dump "$BACKUP_DIR"/catalog-assets-"$BACKUP_STAMP".tar.gz
```

若任一步失败，停止发布，不进入下一步。

## 5. 部署与迁移

```bash
cd /home/admin/tongzhouxing-shop
export APP_ENV_FILE=/home/admin/tongzhouxing-shop/.env.production
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" config --quiet
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" build web worker
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d postgres
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" run --rm web npm run db:migrate
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d web worker
curl -fsS http://127.0.0.1:3000/api/health
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" ps
```

通过标准：

- `config --quiet` 成功。
- `db:migrate` 成功且无回滚动作。
- `web` 与 `worker` 都是 `Up`。
- `GET /api/health` 返回 `200`。

## 6. 只读连接验证

使用超级管理员登录后台，只允许执行以下只读动作：

1. 打开 `系统 > 集成 > 飞书`。
2. 点击“验证只读连接”。
3. 确认页面能读取源工作表和目标工作表元数据。
4. 记录：
   - 源工作表标题
   - 源 sheet id
   - 目标 spreadsheet token 对应的测试表标题

禁止执行：

- “确认迁移 74 个 SKU”
- “重新同步目标测试表”
- 任何会写测试表或触发 outbox 的操作

## 7. 第一次只读预检

仍然只允许超级管理员执行：

1. 选择 `FEISHU_CARGO_SOURCE_SHEET_ID` 对应工作表。
2. 点击“开始只读预检”。
3. 等待预检结果稳定。
4. 记录以下证据：
   - 预检状态
   - `sourceRevision`
   - `sourceDigest`
   - 商品数
   - SKU 数
   - 图片数
   - 总库存
   - 阻塞问题和警告问题数量

Phase A 验证标准：

- 原业务货盘内容、结构、修订号没有因为应用而变化。
- 预检结果里看不到原始 token、file token 或 secret。
- 目标测试表仍为空白，未被应用写入。

## 8. 冻结窗口与最终复检

在业务负责人宣布冻结窗口开始后，执行最终只读复检：

1. 约束相关同事 10 到 20 分钟内不要编辑原业务货盘。
2. 再次执行“开始只读预检”。
3. 比较新旧两次预检：
   - `sourceRevision` 必须一致，或若不一致则重新审阅差异后重新开始冻结窗口。
   - `sourceDigest` 必须一致。
   - 结果应仍为 74 个 SKU、74 张图片，且无阻塞问题。

只要 revision 或 digest 变化，就视为源表已变更，必须重新预检，不能继续。

## 9. Phase A 停止点

做到这里必须停止，并向负责人提交证据。**不要继续执行下面这些动作：**

- 不点击“确认迁移 74 个 SKU”
- 不点击“重新同步目标测试表”
- 不手工写测试表
- 不切换客户查看入口
- 不修改原业务货盘

后续是否进入确认导入和目标表写入，必须在新的明确审批消息中单独授权。

## 10. 回滚与恢复

Phase A 内如果部署后发现问题，但尚未确认迁移：

```bash
cd /home/admin/tongzhouxing-shop
export APP_ENV_FILE=/home/admin/tongzhouxing-shop/.env.production
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" down
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d postgres
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d web worker
```

如果需要恢复到备份前状态：

- 数据库：使用 `postgres-$BACKUP_STAMP.dump` 按既有恢复演练流程恢复到隔离库先验证，再由负责人批准恢复生产。
- 图片卷：使用 `catalog-assets-$BACKUP_STAMP.tar.gz` 恢复。

因为 Phase A 不确认导入，所以正常情况下不应出现业务数据写入；优先使用应用版本回退，而不是直接覆盖数据库。
