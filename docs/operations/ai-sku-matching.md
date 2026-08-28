# 智能核单与 SKU 匹配运行手册

## 安全边界

- 功能只处理订单预览中确定性规则仍无法匹配的 `UNKNOWN_SKU` 系统货品行，每次最多 20 行。
- 服务器先从当前可售、有价格且库存充足的 SKU 中为每行筛出最多 20 个候选；DeepSeek 只能返回这些候选 ID，每行最多三个。
- 发送字段白名单仅包含商品名称、规格、颜色、组合和 SKU；不发送客户名称、邮箱、收件人、地址、联系方式、平台订单号或内部订单标识。
- 商品字段按提示注入内容处理。陌生行、陌生候选、重复 ID、截断 JSON 和不符合 schema 的响应全部拒绝。
- 客户选择后仍必须执行现有“保存并校验”；系统重新确认客户归属、行版本、价格、库存和销售状态，才记录 `AI_CONFIRMED`。AI 不创建 SKU 别名、不锁库存、不改变金额。

## 配置与开放顺序

环境变量只在服务器端配置：

```text
AI_SKU_MATCH_ENABLED=false
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
```

生产开放必须按以下顺序：

1. 执行加法迁移并部署 Web/Worker，保持 `AI_SKU_MATCH_ENABLED=false`。
2. 在受控 secret 管理中写入 `DEEPSEEK_API_KEY`，确认模型仍为固定的 `deepseek-v4-flash`。
3. 打开全局开关并验证健康状态、Worker 队列和手工核单回退路径。
4. 由超级管理员在“账号管理”中填写原因，逐客户开放试用。

供应商地址固定为 `https://api.deepseek.com/chat/completions`，不能用请求参数或环境变量覆盖。实现依据 DeepSeek 官方 [Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 和[错误码](https://api-docs.deepseek.com/quick_start/error_codes/)文档。

## 限流、保留与故障处理

- 每个客户每 10 分钟最多发起 3 次；仍有效的同一行版本建议直接复用，不重复调用模型。
- 单次调用 15 秒超时；仅对空响应、格式错误、429 和 5xx 最多重试一次。401/402 不重试。
- 不保存完整提示词或模型原始响应。运行元数据、候选 ID、接受/拒绝结果和安全错误码保留 30 天，由 Worker 每天 UTC 03:15 清理。
- DeepSeek 不可用时，页面只显示安全错误并保留手工输入。不得把供应商响应、密钥、数据库异常或 PII 写入日志。

## 回退

先将 `AI_SKU_MATCH_ENABLED=false` 并重新发布 Web/Worker；客户端立即回到手工核单，既有订单、库存、金额和已确认行不受影响。无需回滚加法迁移。逐客户授权也可由超级管理员单独关闭。
