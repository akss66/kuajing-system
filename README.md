# 同舟行跨境系统

同舟行跨境系统是一款面向加拿大 TEMU 一件代发业务的全链路 SaaS 产品。它把原本散落在 Excel、飞书、仓库系统和人工对账中的流程，收进一个可追踪、可审计、可恢复的交易与履约工作台。

产品覆盖商品货盘、客户拿货、库存、人民币结算、极风履约、飞书同步和经营分析。当前版本为 `v0.2.0`；PostgreSQL 是订单、库存、资金和履约状态的唯一事实来源，飞书货盘作为受控的只读数据源。

## 产品解决什么问题

跨境一件代发的难点不只是“导入订单”，而是让价格、库存、付款、仓库履约和客户可见状态在异常与并发下仍保持一致。本产品围绕三条主线设计：

- **让客户下单更简单**：上传 TEMU 原始表格后，系统自动识别 SKU、数量、重复订单和缺货问题，并给出可修正的预览结果。
- **让运营处理更可靠**：库存锁定、余额扣款、线下支付、退款、拆包和补发均由明确状态机驱动，关键动作可审计。
- **让外部系统可控接入**：飞书只读同步、极风已有订单匹配和 AI SKU 推荐均采用默认关闭、最小数据和失败安全策略。

## 核心能力

- **账号与隔离**：超级管理员、管理员和固定合作客户分权；客户、店铺与敏感操作均在服务端再次鉴权。
- **商品与库存**：商品、SKU、客户价、SKU 别名、货盘库存、出入库流水和库存覆盖预警。
- **订单导入**：解析 TEMU Excel，校验重复订单、未知 SKU、数量与库存；支持客户自带货和人工修正。
- **智能 SKU 匹配**：可选的 DeepSeek 候选排序；按客户授权，且不向模型发送收件人、地址、联系方式或订单标识。
- **支付与结算**：余额扣款、线下微信付款申报与核款、锁库释放、退款与结算批次。
- **仓库履约**：只匹配极风已有订单，不由本系统创建极风订单；支持状态同步、取消、补发、运单和费用回传。
- **飞书货盘**：从飞书只读导入或在迁移期临时镜像到 PostgreSQL；生产配置强制禁止写回来源表。
- **运营保障**：审计、隐私脱敏、健康检查、Worker 心跳、备份恢复、不可变发布身份和发布门禁。
- **多端界面**：管理员工作台与客户门户，覆盖桌面端及 360/390/430px 移动端。

## 业务边界

```text
TEMU Excel ──> 导入预览/人工修正 ──> 订单与锁库 ──> 支付/结算
                                         │
飞书货盘 ──只读同步──> PostgreSQL <──────┤
                                         │
极风已有订单 <──匹配、状态与运单同步─────┘
```

- PostgreSQL 是主账；不要直接在飞书维护交易状态。
- 极风集成采用“已有订单匹配”模式；系统不会调用极风创建订单接口。
- 普通包裹与补发只在极风确认已发货后扣减库存。
- 金额以整数最小单位存储和计算，禁止使用浮点数处理结算。
- 未配置外部凭据时，相关集成必须安全停用，不能阻塞本地核心业务。

## 技术栈与目录

| 层级 | 技术 / 位置 |
| --- | --- |
| Web | Next.js 16、React 19、TypeScript、Tailwind CSS 4，代码位于 `src/app` 与 `src/components` |
| 业务模块 | `src/modules`，按订单、库存、结算、履约、客户等领域拆分 |
| 数据库 | PostgreSQL 18、Drizzle ORM；迁移位于 `drizzle` |
| 后台任务 | pg-boss，入口为 `src/jobs/worker.ts` |
| 外部集成 | `src/integrations`，包含极风和飞书适配层 |
| 测试 | Vitest 单元/集成测试、Playwright E2E 与视觉回归 |
| 部署 | `Dockerfile`、`compose.production.yaml`、`deploy/systemd` |

## 本地启动

### 前置条件

- Node.js 24+
- Docker Desktop（本地 PostgreSQL）
- PowerShell 7（Windows 推荐）

### 安装并启动

```powershell
Copy-Item .env.example .env.local
docker compose up -d postgres
npm.cmd ci
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

另开一个终端启动常驻任务：

```powershell
$env:DATABASE_URL='postgres://tongzhouxing:tongzhouxing@127.0.0.1:5432/tongzhouxing'
npm.cmd run worker
```

浏览器打开 `http://127.0.0.1:3000`。演示账号、数据库初始化和常见问题见[本地开发手册](docs/operations/local-development.md)。

> `.env.local`、`.env.production`、极风一次性 token、API 密钥、数据库口令和客户数据都不得提交到 Git。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd run dev` | 启动开发服务器 |
| `npm.cmd run worker` | 启动后台任务 Worker |
| `npm.cmd run db:migrate` | 执行数据库迁移 |
| `npm.cmd run db:seed` | 写入本地演示数据 |
| `npm.cmd test` | 单元测试 |
| `npm.cmd run test:integration` | 串行数据库集成测试 |
| `npm.cmd run test:e2e` | Playwright 桌面与移动端测试 |
| `npm.cmd run typecheck` | TypeScript 类型检查 |
| `npm.cmd run lint` | ESLint 检查 |
| `npm.cmd run build` | Next.js 生产构建 |
| `npm.cmd run diff-check` | 发布差异与敏感文件检查 |

提交前至少运行与改动相关的测试；合并到 `main` 前应完成全部发布门禁。GitHub Actions 会在 PR 以及 `main`、`codex/**` 推送时执行完整检查。

## 配置原则

复制 `.env.example` 后按环境填写。所有真实值只放在本地或生产 Secret 管理中。

- `DATABASE_URL`：应用数据库连接。
- `BETTER_AUTH_SECRET`、`PII_ENCRYPTION_KEY`：认证与隐私数据加密密钥。
- `AI_SKU_MATCH_ENABLED`、`DEEPSEEK_API_KEY`：智能 SKU 匹配；默认关闭，还需逐客户授权。
- `JIFENG_*`：极风开发者凭据和独立 token 加密密钥。
- `FEISHU_*`：飞书只读货盘来源、迁移镜像和通知配置。
- `APP_VERSION`、`RELEASE_SHA`：生产镜像必须绑定当前完整 Git 提交，不允许使用 `latest` 或 `current`。

任何环境都应保持 `FEISHU_CARGO_WRITES_ENABLED=false`。完整变量说明见 [.env.example](.env.example)。

## 极风授权与安全上线

1. 在 Secret 管理中配置 `JIFENG_BASE_URL`、`JIFENG_CLIENT_ID`、`JIFENG_CLIENT_SECRET` 和 `JIFENG_TOKEN_ENCRYPTION_KEY`，执行迁移并重启 Web/Worker。新部署默认关闭自动履约。
2. 超级管理员从极风 OMS 获取一次性 token，在后台完成授权；系统只保存加密后的 access/refresh token。
3. 确认唯一的加拿大仓库和 Canada Post 渠道；存在多个候选时必须人工选择。
4. 执行“只读诊断”，并确认页面、日志和审计中没有邮箱、一次性 token、授权码或 access/refresh token。
5. 诊断通过后仍保持“已就绪，未启用”。只有业务负责人确认真实订单将进入仓库履约后，才能二次确认启用。

授权失败或一次性 token 已消费时，应获取新 token，不能复用、记录或写入环境文件。

## 产品设计与工程实践

这不是一个只覆盖“成功路径”的演示项目。设计和实现重点放在真实业务最容易出错的边界：

- 订单重复提交、支付回调与仓库状态同步均采用幂等设计。
- 客户数据按 `customerId` 隔离，敏感动作在 Server Action 和服务层重复鉴权。
- 库存、金额和履约状态通过数据库事务与显式状态机保持一致。
- Worker 具备心跳与恢复机制，健康接口同时暴露 Web、数据库和后台任务状态。
- 发布镜像绑定 Git SHA，不使用 `latest`；数据库迁移、备份和回滚都有可执行手册。
- 单元、集成、E2E、视觉回归、类型检查、Lint、构建和依赖审计组成持续集成门禁。

生产由 `compose.production.yaml` 启动 PostgreSQL、Web 和 Worker。更深入的产品与工程资料：

- [产品定义](PRODUCT.md)
- [管理员体验规范](DESIGN.admin.md)
- [客户门户体验规范](DESIGN.portal.md)
- [生产运行手册](docs/operations/production-runbook.md)
- [发布门禁](docs/operations/release-gates.md)
- [AI SKU 匹配设计](docs/operations/ai-sku-matching.md)
- [v0.2.0 版本说明](docs/releases/v0.2.0.md)

## 当前上线条件

代码和自动化门禁不等于生产保障已经完成。正式无人值守放量前，仍需留存外部监控、Worker 自动恢复、最近备份、隔离恢复演练、回滚镜像和日志脱敏等证据。缺少任一项时，只能进行人工值守试运行。

正式联调还需要业务方提供极风正式开发者凭据、加拿大仓库/Canada Post 渠道，以及飞书自建应用与文档/群权限。没有这些凭据时，外部集成会安全停用，本地业务和模拟验收仍可运行。
