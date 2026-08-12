# 备份恢复演练记录：2026-08-12

## 范围

- 来源：本地 Docker PostgreSQL `tongzhouxing`
- 临时目标：`tongzhouxing_restore_drill_20260812_0805`
- 备份格式：`pg_dump --format=custom --no-owner --no-privileges`
- 恢复策略：只恢复到已创建且无 public 表的数据库

## 结果

1. `backup-postgres.ps1` 成功生成非空 `.dump` 文件。
2. `restore-postgres.ps1` 成功恢复到空的临时数据库。
3. `customers`、`stores`、`skus`、`inventory_balances`、`fulfillment_orders`、`order_shipments`、`wallet_transactions`、`audit_logs` 的来源库与恢复库行数逐表一致。
4. 对已经包含 29 张 public 表的恢复库再次执行恢复时，脚本按设计拒绝覆盖。
5. 验证完成后，已核对名称并删除唯一临时演练数据库；原始开发库未被修改。

## 结论

备份、空库恢复、关键表核对和防覆盖保护均通过。正式环境仍需按月在隔离基础设施重复演练，并额外验证最近订单、审计记录和加密收件信息可由当期密钥解密。
