# 上传订单多货品映射设计规范

日期：2026-08-31

状态：业务意图已由用户逐项确认

## 1. 目标

客户在订单预览中可以把一条 TEMU 上传明细映射为一个或多个实际发货货品，用于捆绑销售等场景。系统必须永久保留上传文件中的原 SKU，同时对每个最终货品独立处理数量、库存和货款。

成功标准：

- 一条可编辑的上传明细可通过“加一个货”新增多个最终货品，也可修改或删除新增货品。
- 每个最终货品有独立 SKU 和实际发货数量。
- 上传时的 `externalSku` 是不可变原值；修改最终货品不得覆盖它。
- 最终 SKU 以 `TZX-`（大小写不敏感）开头时，必须匹配当前可售、有有效拿货价且库存充足的系统 SKU，并计入货款与库存锁定。
- 非 `TZX-` SKU 是客户自有货：允许自由文本，服务端去除首尾空格并拒绝空值，不查商品库存且货款恒为零。
- 同一上传明细可混合系统 SKU 和客户自有货。运费仍按现有包裹规则计算一次，不因货品数增加而重复收费。
- 极风导出按最终货品拆行；各行重复同一原 SKU，并分别输出最终 SKU 和实际发货数量。

## 2. 数据与行为契约

### 2.1 原始行与最终货品

- `order_import_rows.external_sku` 继续表示上传文件原 SKU，任何客户编辑操作都不得更新该字段。
- 原始行保留第一项最终货品的兼容字段；新增独立子表保存第二项及后续最终货品，避免改变上传行计数、重复订单判定和包裹数。
- 客户自有货的最终 SKU 必须与原 SKU 分开存储，以支持把非 TZX 原 SKU 改成另一个非 TZX SKU。
- 每个上传行最多保存 20 个最终货品，防止单次表单或数据库写入无界增长。

### 2.2 保存与并发

- 浏览器只提交批次 ID、上传行 ID、可选子货品 ID、SKU 文本、数量和预期版本。
- Server Action 必须重新验证登录客户、批次归属、预览状态、有效期和行版本。
- 服务端根据最终 SKU 前缀推导货品模式；不接受浏览器传入价格、库存、客户 ID 或货品模式。
- 系统 SKU 保存前和订单提交前均重新检查可售状态、价格和库存。
- 新增、修改、删除任一最终货品都递增上传行版本，使旧页面提交得到明确冲突错误。

### 2.3 金额、库存和履约

- 系统 SKU 的货款为当前精确拿货价乘该货品实际发货数量；客户自有货货款为零。
- 同一系统 SKU 在多个上传行或同一行多个货品中出现时，库存需求必须汇总后校验和锁定。
- 订单 `totalQuantity` 为全部最终货品数量之和。
- 包裹仍按平台订单号创建；增加最终货品只增加订单明细，不增加包裹或运费。
- 一条平台子订单可对应多条订单明细；去重仍按平台子订单判断，而不是按最终货品判断。

### 2.4 展示与导出

- 预览卡片固定展示不可变“原 SKU”，并逐项展示最终 SKU、数量、模式及系统 SKU 的可用库存。
- 编辑区提供“加一个货”；新增项保存前可取消，已保存新增项可修改或删除。
- 桌面与 360/390/430px 移动端不得出现横向溢出，交互目标不小于 44px，保存错误使用可访问的状态播报。
- 极风导出中 `原SKU货号` 来自不可变原 SKU，`SKU货号` 来自各最终货品，数量来自各自实际发货数量。

## 3. 技术栈与项目结构

- Next.js 16.3 App Router、React 19、TypeScript、Zod、Drizzle ORM、PostgreSQL。
- Server Actions 位于 `src/modules/order-import/actions.ts`，每个操作都在服务端重新认证和授权。
- 领域逻辑位于 `src/modules/order-import`、`src/modules/orders` 和 `src/modules/bulk-order`。
- 客户端组件位于 `src/components/order-import`。
- 数据结构位于 `src/db/schema/orders.ts`，前向迁移位于 `drizzle/`。
- 单元、集成和 E2E 分别位于 `tests/unit`、`tests/integration`、`tests/e2e`。

代码保持现有显式领域函数风格，例如服务端从可信数据重新推导模式：

```ts
const normalizedSkuCode = input.skuCode.trim();
const fulfillmentMode = deriveImportSkuResolution(normalizedSkuCode).fulfillmentMode;
```

## 4. 命令

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run test:e2e -- --workers 1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd audit --omit=dev
npm.cmd run diff-check
```

模式变更使用：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run db:generate
```

## 5. 测试策略

- 单元测试：表单多货品状态、非 TZX 去空格/非空、前缀模式推导、移动端结构。
- 集成测试：不可变原 SKU、客户隔离、CAS 冲突、增改删子货品、混合计费、汇总库存、提交时下架/改价/库存竞争、单包裹运费、批量提交兼容和极风拆行导出。
- E2E：从未知或客户自有货行改为 TZX、新增非 TZX 货品、保存、提交；覆盖桌面和移动端。
- 每项逻辑变更先观察新增测试在旧实现上失败，再实现为通过。

## 6. 边界

始终执行：服务端输入校验、客户归属校验、提交时价格/库存重验、整数金额计算、原子事务和审计记录。

需要另行授权：生产迁移、生产数据写入、容器重启和部署。

禁止：自动拆解组合 SKU 字符串、根据连字符猜测货品、让非 TZX 货品产生货款或库存锁定、改变每包 ¥13 的现有规则、写入飞书。

本次不增加公共 REST API、不新增依赖、不改变订单状态机或 AI SKU 推荐范围。

## 7. 开放问题

无。业务规则已在实施前逐项确认。
