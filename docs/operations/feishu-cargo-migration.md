# 飞书货盘只读迁移上线手册

日期：2026-08-14
适用范围：`tongzhouxing-shop` 首批飞书货盘迁移到 PostgreSQL

## 1. 永久安全边界

- 原业务飞书 Wiki/电子表格始终只读，禁止调用任何飞书写接口。
- 不配置目标 spreadsheet/sheet，不创建飞书镜像表。
- `compose.production.yaml` 必须把 `FEISHU_CARGO_WRITES_ENABLED` 硬编码为 `false`，环境文件不能覆盖。
- `FEISHU_CARGO_IMPORT_ENABLED` 只控制“已确认的预检快照写入 PostgreSQL”，不控制飞书远程写入。
- 只有超级管理员可以执行只读预检和一次性数据库导入。
- 没有新鲜的 `PREFLIGHT_READY` 结果、数据库备份或数量核验时，禁止打开数据库导入开关。

## 2. 本次源表解释规则

- “74”是源表商品序号数量，不是 SKU 数量。
- SKU 按 `TZX-数字` 的商品编号分组，例如 `TZX-034-1/2/3` 同属商品 34，但仍是 3 个独立 SKU。
- 预期只读预检应得到 76 个商品、140 个 SKU、140 张图片；以真实预检结果和问题明细为最终依据。
- `TZX-077` 是末尾未完成草稿，本次跳过并显示警告；中间缺资料行仍然阻断。
- 单价以“厘”（人民币千分之一元）精确保留：`0.325`→325 厘、`1.366`→1366 厘。
- `0.58/6PCS` 和 `0.35/5PCS` 分别是一个整包 SKU 的价格，不按 PCS 拆分。
- 订单行金额在 `数量 × 精确厘价` 后，才四舍五入到分。
- `50g/包`→50g，`9g*4`→36g，`6g*3`→18g，`12.5g`→13g。
- 商品链接单元格只有 `0` 时写入数据库 `null`。
- 所有上述旧格式转换都必须在预检里显示 `WARNING`，未知格式继续阻断。

## 3. 生产配置

密钥只写入 `/home/admin/tongzhouxing-shop/secrets/.env.production`，不要放进 shell 历史、聊天或截图：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_CARGO_SOURCE_WIKI_TOKEN=
FEISHU_CARGO_SOURCE_SHEET_ID=
FEISHU_CARGO_IMPORT_ENABLED=false
FEISHU_CARGO_WRITES_ENABLED=false
FEISHU_CARGO_TARGET_SPREADSHEET_TOKEN=
FEISHU_CARGO_TARGET_SHEET_ID=
CATALOG_ASSET_DIR=/app/data/catalog-assets
```

目标表两个变量必须留空。部署与预检期间两个开关都保持 `false`。

## 4. 部署只读版本

```bash
cd /home/admin/tongzhouxing-shop
export APP_ENV_FILE=/home/admin/tongzhouxing-shop/secrets/.env.production
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" config --quiet
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" build web worker
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d postgres
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" run --rm web npm run db:migrate
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" up -d web worker
curl -fsS https://shop.tzxai.top/api/health
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" ps
```

通过标准：迁移成功，Web/Worker 健康，`FEISHU_CARGO_IMPORT_ENABLED=false`，`FEISHU_CARGO_WRITES_ENABLED=false`，目标表配置为空。

## 5. 只读预检

超级管理员在 `系统 > 集成 > 飞书`：

1. 验证只读连接。
2. 选择源 sheet，点击“开始只读预检”。
3. 记录 source revision、source digest、商品数、SKU 数、图片数、总库存、阻断数和警告明细。
4. 核对商品编号分组、全部 140 个 SKU、图片、精确价格、重量和链接转换。
5. 确认预检后业务表仍为空：`products=0`、`skus=0`、`inventory_balances=0`。

若状态不是 `PREFLIGHT_READY`、数量不符、存在未知转换或 revision/digest 变化，立即停止，不导入。

## 6. 导入前备份

```bash
cd /home/admin/tongzhouxing-shop
export APP_ENV_FILE=/home/admin/tongzhouxing-shop/secrets/.env.production
export BACKUP_DIR=/home/admin/backups/feishu-cargo-migration
export BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
docker compose -f compose.production.yaml --env-file "$APP_ENV_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges \
  > "$BACKUP_DIR/postgres-$BACKUP_STAMP.dump"
docker run --rm \
  -v tongzhouxing_shop_catalog_assets:/from \
  -v "$BACKUP_DIR":/to \
  alpine sh -c "cd /from && tar -czf /to/catalog-assets-$BACKUP_STAMP.tar.gz ."
ls -lh "$BACKUP_DIR/postgres-$BACKUP_STAMP.dump" \
  "$BACKUP_DIR/catalog-assets-$BACKUP_STAMP.tar.gz"
```

任何一步失败都必须停止。

## 7. 一次性写入 PostgreSQL

仅在第 5、6 节全部通过后：

1. 把 `FEISHU_CARGO_IMPORT_ENABLED` 临时改为 `true`。
2. 只重建 Web/Worker，确认飞书写入开关仍为 `false`。
3. 超级管理员对刚刚核验的 ready run 输入页面给出的动态确认语句（应按真实 SKU 数生成，例如 `确认迁移140个SKU`）。
4. 导入成功后立即把 `FEISHU_CARGO_IMPORT_ENABLED` 改回 `false`，再次重建 Web/Worker。

任何时候都不得设置 `FEISHU_CARGO_WRITES_ENABLED=true`。

## 8. 导入后核验

- `products`、`skus`、`inventory_balances`、`catalog_assets` 数量与 ready run 一致。
- 每个 SKU 恰好一个图片资产和一个库存余额。
- `0.325`、`1.366` 等价格在后台和客户货盘中按真实精度显示。
- 订单使用精确厘价计算，最终行金额按分四舍五入。
- 库存总和与预检一致，0 库存 SKU 为不可售。
- 导入审计存在且不含 App Secret、token、file token 或收件人隐私。
- `integration_outbox` 没有飞书目标写入成功记录，源 revision 没有被应用改变。
- Web/Worker 健康，两个生产开关最终都为 `false`。

## 9. 恢复

发现异常时先停止 Web/Worker 并保持 PostgreSQL 容器运行。使用备份恢复到隔离库核验后，再决定生产恢复；图片卷同样先在隔离位置验证。不要通过修改原飞书业务表来“修复”系统数据。
