# 极风 WMS 安全授权与履约启用门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让超级管理员通过极风官方“一次性授权 token → 授权码 → access/refresh token”协议完成安全接入，自动发现仓库和加拿大邮政渠道，并在明确启用前阻止所有真实极风写请求。

**Architecture:** 服务器环境只保存极风开发者凭据和令牌加密主密钥；PostgreSQL 保存单例连接状态以及 AES-256-GCM 加密令牌。`src/modules/jifeng-connection` 负责授权、刷新、资源发现、诊断与状态机；履约 action 和 worker 统一从凭据提供者读取已启用连接，避免静态环境变量绕过数据库启用门。

**Tech Stack:** Next.js 16.3 App Router/Server Actions、React 19、TypeScript 6、Zod 4、Drizzle ORM 0.45、PostgreSQL、Node.js 24 `node:crypto`、Vitest、Playwright。

## Global Constraints

- 只使用极风官方契约：`GET /api/oauth/authorize` 接收 `domain/clientId/email/token`；`GET /api/oauth/accessToken` 接收 `clientId/clientSecret/key`；`GET /api/oauth/refreshToken` 接收 `clientId/clientSecret/refreshToken/userId`。
- OMS 邮箱、一次性授权 token、授权码、access token、refresh token、client secret、请求签名绝不进入日志、审计、UI、Action 返回值或普通查询 DTO。
- `JIFENG_BASE_URL` 在生产环境不可被请求参数覆盖；不从 `Host`、`Origin` 或转发头拼接第三方域名。
- `JIFENG_TOKEN_ENCRYPTION_KEY` 是独立 32 字节密钥；令牌使用 AES-256-GCM、独立随机 nonce 和版本化信封加密。
- 极风库存不是系统货盘库存来源；本计划不读取极风库存来覆盖本地库存。
- 数据库连接存在时优先于旧静态 token 配置；静态 token 只作短期兼容，且不能绕过 `fulfillmentEnabled`。
- `ENABLED` 以外状态不得调用创建、取消或其他极风写接口；停用后仍允许只读查询完成外部不确定状态对账。
- 真实极风验收只执行授权、仓库/物流渠道发现和订单不存在查询；首次真实推单需另行获得用户明确批准。
- Server Action 是不可信 POST 入口：每个 action 内重新鉴权、Zod 校验，并只返回页面需要的脱敏字段。
- 不覆盖现有未提交的 `config.ts`、`diagnostics.ts` 及其测试；Task 1 先把它们收敛为独立基线提交。

---

## File Structure

### 新建文件

- `src/db/schema/jifeng.ts`：连接状态枚举、单例连接表和授权尝试表。
- `drizzle/0015_jifeng_oauth_connection.sql` 与 `drizzle/meta/*`：前向数据库迁移。
- `src/integrations/jifeng/oauth-client.ts`：官方授权码、token 兑换和 refresh HTTP 契约。
- `src/integrations/jifeng/resources.ts`：仓库和线下物流渠道读取、加拿大邮政候选判定。
- `src/modules/jifeng-connection/crypto.ts`：版本化 AES-256-GCM 信封加解密。
- `src/modules/jifeng-connection/types.ts`：连接状态、公共 DTO、端口类型。
- `src/modules/jifeng-connection/service.ts`：授权、刷新、资源选择、诊断、启停、断开状态机。
- `src/modules/jifeng-connection/queries.ts`：脱敏管理页读模型和普通管理员只读状态。
- `src/modules/jifeng-connection/provider.ts`：为 worker/履约 action 生成数据库支持的 client/config。
- `src/modules/jifeng-connection/actions.ts`：超级管理员 Server Actions。
- `src/components/integrations/jifeng-connection-card.tsx`：集成管理 UI。
- 对应 unit、PostgreSQL integration 和 Playwright E2E 测试文件。

### 修改文件

- `src/db/schema/index.ts`：导出极风连接 schema。
- `src/integrations/jifeng/config.ts`、`diagnostics.ts`、`index.ts`、`client.ts`、`types.ts`：配置分层、只读诊断、资源 API、外部 refresh 控制。
- `src/app/(admin)/admin/system/integrations/page.tsx`：使用新读模型和极风卡片，同时修复该页当前乱码文案。
- `src/modules/fulfillment/actions.ts`：取消动作改用数据库凭据提供者和启用门。
- `src/jobs/worker.ts`：每轮动态读取数据库连接，不再以静态 token 决定是否启动。
- `.env.example`、`README.md`、`compose.production.yaml`：新密钥边界和生产配置说明。

## Task 1: 收敛现有配置分层和只读诊断基线

**Files:**
- Modify: `src/integrations/jifeng/config.ts`
- Modify: `src/integrations/jifeng/index.ts`
- Create/Modify: `src/integrations/jifeng/diagnostics.ts`
- Create/Modify: `tests/unit/integrations/jifeng-config.test.ts`
- Create/Modify: `tests/unit/integrations/jifeng-diagnostics.test.ts`

**Interfaces:**
- Produces: `inspectJifengConfiguration(env)`, `readJifengDeveloperConfig(env)`, `readJifengAuthorizedConfig(env)`, `runJifengConnectivityDiagnostic(input)`.
- Invariant: `10026` 是签名/认证拒绝，测试断言 `AUTHENTICATION_REJECTED`；诊断只调用 `getOrder`。

- [ ] **Step 1: 记录当前真实失败**

Run:

```powershell
npm.cmd test -- tests/unit/integrations/jifeng-config.test.ts tests/unit/integrations/jifeng-diagnostics.test.ts tests/unit/integrations/jifeng-client.test.ts
```

Expected: `jifeng-diagnostics.test.ts` 的 `10026` 分类断言失败，实际值为 `AUTHENTICATION_REJECTED`；其余测试通过。

- [ ] **Step 2: 修正测试契约并补安全断言**

在 `jifeng-diagnostics.test.ts` 中使用：

```ts
expect(result.remoteProbe).toMatchObject({
  attempted: true,
  code: "10026",
  outcome: "AUTHENTICATION_REJECTED",
});
expect(JSON.stringify(result)).not.toContain("secret-token");
expect(getOrder).toHaveBeenCalledTimes(1);
```

再补生产域名覆盖测试，断言 `baseUrlOverride` 在 `nodeEnv: "production"` 时抛 `JifengConfigError`，且错误不包含覆盖 URL。

- [ ] **Step 3: 运行定向单测和静态检查**

Run:

```powershell
npm.cmd test -- tests/unit/integrations/jifeng-config.test.ts tests/unit/integrations/jifeng-diagnostics.test.ts tests/unit/integrations/jifeng-client.test.ts
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Expected: 全部 PASS/exit 0。

- [ ] **Step 4: 只提交现有基线**

```powershell
git add src/integrations/jifeng/config.ts src/integrations/jifeng/index.ts src/integrations/jifeng/diagnostics.ts tests/unit/integrations/jifeng-config.test.ts tests/unit/integrations/jifeng-diagnostics.test.ts
git commit -m "feat: add safe Jifeng configuration diagnostics"
```

## Task 2: 建立加密连接数据模型

**Files:**
- Create: `src/db/schema/jifeng.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/0015_jifeng_oauth_connection.sql`
- Modify: `drizzle/meta/_journal.json`
- Create/Modify: generated `drizzle/meta/*_snapshot.json`
- Create: `src/modules/jifeng-connection/crypto.ts`
- Create: `src/modules/jifeng-connection/types.ts`
- Create: `tests/unit/jifeng-connection/crypto.test.ts`
- Create: `tests/integration/jifeng-connection/schema.test.ts`

**Interfaces:**

```ts
type JifengConnectionStatus =
  | "DISCONNECTED"
  | "AUTHORIZED"
  | "RESOURCE_SELECTION_REQUIRED"
  | "READY_DISABLED"
  | "ENABLED"
  | "REFRESH_REQUIRED"
  | "ERROR";

type EncryptedSecret = {
  version: 1;
  ciphertext: string;
  iv: string;
  tag: string;
};

encryptJifengSecret(plaintext: string, key: Buffer): EncryptedSecret;
decryptJifengSecret(envelope: EncryptedSecret, key: Buffer): string;
```

`jifengConnections.connectionKey` 固定为 `PRIMARY` 且唯一。`jifengAuthorizationAttempts` 只保存管理员 ID、结果、时间和脱敏错误分类，不保存邮箱/token/code。

- [ ] **Step 1: 写加密 RED 单测**

覆盖：相同明文两次加密得到不同 IV/密文；正确密钥可解密；错误密钥、篡改 ciphertext/tag、未知版本全部抛 `JifengSecretError`；异常消息不包含明文。

Run: `npm.cmd test -- tests/unit/jifeng-connection/crypto.test.ts`。
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 AES-256-GCM 信封**

使用 `randomBytes(12)`、`createCipheriv("aes-256-gcm", key, iv)`、`getAuthTag()`；字段使用 base64url。只接受解码后严格 32 字节的 `JIFENG_TOKEN_ENCRYPTION_KEY`。

- [ ] **Step 3: 写 schema RED 集成测试**

测试：第二个 `PRIMARY` 连接被唯一约束拒绝；状态、授权人、启用人外键存在；授权尝试表没有 `email/token/code` 列。

Run: `npm.cmd run test:integration -- tests/integration/jifeng-connection/schema.test.ts`。
Expected: FAIL，表不存在。

- [ ] **Step 4: 实现 schema 并生成迁移**

连接表包含固定键、状态、两个 JSONB 加密信封、userId、token 到期时间、仓库/物流标识和名称、授权/启用操作者与时间、诊断时间、脱敏错误、时间戳。初始行不由 seed 创建，service 按固定键 upsert。

Run:

```powershell
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npm.cmd run db:generate
npm.cmd run db:migrate
npm.cmd run test:integration -- tests/integration/jifeng-connection/schema.test.ts
```

Expected: `0015` 应用成功，schema tests PASS，Drizzle 无 drift。

- [ ] **Step 5: 验证并提交**

Run unit、integration、typecheck、lint、`git diff --check`。
Commit: `feat: store encrypted Jifeng connection state`。

## Task 3: 实现极风官方授权和资源读取客户端

**Files:**
- Create: `src/integrations/jifeng/oauth-client.ts`
- Create: `src/integrations/jifeng/resources.ts`
- Modify: `src/integrations/jifeng/client.ts`
- Modify: `src/integrations/jifeng/types.ts`
- Modify: `src/integrations/jifeng/index.ts`
- Create: `tests/unit/integrations/jifeng-oauth-client.test.ts`
- Create: `tests/unit/integrations/jifeng-resources.test.ts`
- Modify: `tests/unit/integrations/jifeng-client.test.ts`

**Interfaces:**

```ts
authorizeJifengUser(input: {
  baseUrl: string;
  clientId: string;
  domain: string;
  email: string;
  oneTimeToken: string;
}): Promise<{ authorizationCode: string; requestId?: string }>;

exchangeJifengAuthorizationCode(input: {
  authorizationCode: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<JifengTokenSet>;

refreshJifengTokenSet(input: JifengRefreshInput): Promise<JifengTokenSet>;
JifengClient.getWarehouses(): Promise<JifengWarehouse[]>;
JifengClient.getOfflineLogistics(): Promise<JifengOfflineLogistics[]>;
classifyCanadaPostCandidates(channels: JifengOfflineLogistics[]): JifengCandidateResult;
```

- [ ] **Step 1: 写 OAuth 协议 RED 单测**

逐项断言 authorize 只有 `domain/clientId/email/token`，accessToken 只有 `clientId/clientSecret/key`，refresh 只有 `clientId/clientSecret/refreshToken/userId`。错误对象不含 secret/token/code；响应必须含正整数有效期和非空 token/userId。

Run: `npm.cmd test -- tests/unit/integrations/jifeng-oauth-client.test.ts`。
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现 OAuth client**

共用 10 秒 AbortController、Zod 响应 schema 和脱敏错误分类。不要把带 query string 的 URL写入异常或日志。

- [ ] **Step 3: 写资源读取 RED 单测**

断言 `/api/warehouse/getList` body 为 `{ codeList: [] }`；`/api/logistics/offline/page` body 为 `{ pageNo: 1, pageSize: 300, returnAll: true }`。候选识别接受明确 `Canada Post/加拿大邮政` 名称或已确认 carrier code；零个/多个候选返回歧义，绝不默认第一项。

- [ ] **Step 4: 实现资源 API 和候选判定**

在 `JifengClient` 暴露两个强类型只读方法。物流识别规则集中在 `resources.ts`，便于拿到生产返回后增补已确认 code。

- [ ] **Step 5: 验证并提交**

Run OAuth/resource/client unit、typecheck、lint、diff check。
Commit: `feat: implement official Jifeng authorization client`。

## Task 4: 实现授权、刷新、资源选择和审计状态机

**Files:**
- Create: `src/modules/jifeng-connection/service.ts`
- Create: `src/modules/jifeng-connection/queries.ts`
- Create: `tests/integration/jifeng-connection/service.test.ts`

**Interfaces:**

```ts
authorizeJifengConnection(input: {
  actor: SuperAdminPrincipal;
  email: string;
  oneTimeToken: string;
  port?: JifengAuthorizationPort;
  now?: Date;
}): Promise<JifengConnectionAdminView>;

refreshJifengConnection(input?: RefreshOptions): Promise<JifengRuntimeCredentials>;
discoverJifengResources(input: DiscoveryInput): Promise<JifengResourceDiscovery>;
selectJifengResources(input: ResourceSelectionInput): Promise<void>;
runStoredJifengDiagnostic(input: DiagnosticInput): Promise<JifengDiagnosticView>;
setJifengFulfillmentEnabled(input: ActivationInput): Promise<void>;
disconnectJifengConnection(input: DisconnectInput): Promise<void>;
getJifengConnectionAdminView(): Promise<JifengConnectionAdminView>;
getJifengConnectionPublicStatus(): Promise<JifengConnectionPublicStatus>;
```

- [ ] **Step 1: 写服务 RED 集成测试**

覆盖：只接受 SUPER_ADMIN actor；一次性 token 不落库；授权→加密存储→自动发现；单一资源进入 `READY_DISABLED`，歧义进入 `RESOURCE_SELECTION_REQUIRED`；兑换失败保留旧连接；审计 metadata 不含 email/token/code/secret。

Run: `npm.cmd run test:integration -- tests/integration/jifeng-connection/service.test.ts`。
Expected: FAIL，service 不存在。

- [ ] **Step 2: 实现授权事务和速率限制**

同一 actor 10 分钟最多 5 次授权尝试。远程调用在事务外；成功后用短事务锁定 `PRIMARY` 行并写密文和审计。失败只写脱敏尝试，不改旧连接。

- [ ] **Step 3: 实现资源选择和启用条件**

启用必须要求授权有效或可刷新、仓库/物流非空、最后诊断成功且不早于资源变更。失败抛稳定业务错误码。

- [ ] **Step 4: 写并发 refresh RED 测试**

两个调用同时临近过期时只允许一个远程 refresh；另一个等待行锁后复用新 token。refresh 失败置 `REFRESH_REQUIRED` 并阻止新写任务，但不删除密文。

- [ ] **Step 5: 实现单航班 refresh、停用和断开**

用数据库行锁 + 到期时间二次检查。断开先停用，再清空令牌、userId 和资源字段，并写带操作原因的审计。

- [ ] **Step 6: 验证并提交**

Run schema/service integration、typecheck、lint、diff check。
Commit: `feat: govern Jifeng connection lifecycle`。

## Task 5: 建立运行时凭据提供者和不可绕过的履约门

**Files:**
- Create: `src/modules/jifeng-connection/provider.ts`
- Modify: `src/jobs/worker.ts`
- Modify: `src/modules/fulfillment/actions.ts`
- Modify: `src/modules/fulfillment/dispatch.ts` only if an eligibility port is needed before claims
- Create: `tests/integration/jifeng-connection/provider.test.ts`
- Modify: `tests/integration/fulfillment/dispatch.test.ts`
- Modify: `tests/integration/fulfillment/replacement.test.ts`

**Interfaces:**

```ts
getJifengReadClient(): Promise<{ client: JifengClient; config: DispatchConfig }>;
getEnabledJifengWriteClient(): Promise<{ client: JifengClient; config: DispatchConfig }>;
runJifengFulfillmentCycle(): Promise<JifengCycleSummary>;
```

- [ ] **Step 1: 写履约门 RED 集成测试**

状态矩阵：除 `ENABLED` 外全部拒绝 write client。静态 env 即使含旧 access token，也不得绕过数据库中的 `READY_DISABLED`。

- [ ] **Step 2: 实现 provider**

数据库连接存在时解密并按需 refresh；数据库无记录时允许旧静态配置用于只读诊断。写 provider 默认拒绝旧静态配置，只有显式 `JIFENG_LEGACY_FULFILLMENT_ENABLED=true` 才兼容；生产不设置。

- [ ] **Step 3: 写 worker/action RED 回归**

停用时 worker 不调用 enqueue/create/cancel；启用后每轮重新读取状态；订单取消 action 在连接停用时不可外呼。

- [ ] **Step 4: 接管 worker 和 fulfillment actions**

worker 始终注册极风周期队列，每轮通过 provider 决定 disabled 或执行。取消 action 使用 write provider，对账查询使用 read provider。保持现有 reconciliation、claim token、取消/退款安全语义。

- [ ] **Step 5: 履约回归并提交**

Run provider、dispatch、replacement、status-sync integration + static gates。
Commit: `feat: enforce Jifeng fulfillment activation gate`。

## Task 6: 实现超级管理员管理动作和集成 UI

**Files:**
- Create: `src/modules/jifeng-connection/actions.ts`
- Create: `src/components/integrations/jifeng-connection-card.tsx`
- Modify: `src/app/(admin)/admin/system/integrations/page.tsx`
- Create: `tests/unit/jifeng-connection/actions.test.ts`
- Create: `tests/unit/jifeng-connection/connection-card.test.tsx`

**Interfaces:**

```ts
authorizeJifengConnectionAction(previous: ActionState, formData: FormData): Promise<ActionState>;
discoverJifengResourcesAction(previous: ActionState, formData: FormData): Promise<ActionState>;
selectJifengResourcesAction(previous: ActionState, formData: FormData): Promise<ActionState>;
runJifengDiagnosticAction(previous: ActionState, formData: FormData): Promise<ActionState>;
setJifengFulfillmentAction(previous: ActionState, formData: FormData): Promise<ActionState>;
disconnectJifengConnectionAction(previous: ActionState, formData: FormData): Promise<ActionState>;
```

- [ ] **Step 1: 写 action 安全 RED 单测**

mock `requireSuperAdmin` 和 service，验证每个 action 重新鉴权；授权只接受合法 email 和 16–512 字符 token；返回值不含 token。断开/启用/停用要求 2–500 字操作原因。

- [ ] **Step 2: 实现 actions**

使用 `revalidatePath("/admin/system/integrations")`；只映射明确业务错误码，未知错误继续抛出，不回显第三方 message。

- [ ] **Step 3: 写卡片 RED 单测**

覆盖七种状态、普通管理员只读、超级管理员表单、token 输入 `type=password` 且无 value、启用后果确认、断开危险确认、歧义资源显式选择、移动布局无宽表。

- [ ] **Step 4: 实现 UI 并修复页面乱码**

复用 `PageHeading/MetricStrip/WorkspacePanel/ActionForm/ConfirmedActionForm`。统一正确中文；developer ID 和 userId 只显示首尾脱敏；不渲染 secret/token/code。

- [ ] **Step 5: 验证并提交**

Run action/card unit、typecheck、lint、diff check。
Commit: `feat: add Jifeng connection administration`。

## Task 7: 端到端、安全和部署配置验收

**Files:**
- Create: `tests/e2e/jifeng-connection.spec.ts`
- Modify: `tests/e2e/support/test-database.ts` only to include new tables
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `compose.production.yaml`

- [ ] **Step 1: 写 E2E RED**

覆盖：超级管理员授权→单一资源发现→只读诊断→仍未启用→确认启用；普通管理员只读且不能调用 action；无效/已消费 token 不泄露；390px 可确认资源。使用 mock 极风 HTTP，不访问真实极风；reset 前断言数据库名以 `_test` 结尾。

- [ ] **Step 2: 更新 reset 和部署配置**

集中 reset helper 加入新表。`.env.example` 将静态 token/warehouse/logistics 标为旧版兼容；生产 compose 只引用新密钥名，不写具体值。

- [ ] **Step 3: 运行 E2E**

```powershell
npm.cmd run test:e2e -- tests/e2e/jifeng-connection.spec.ts --workers 1
```

Expected: desktop + mobile PASS，0 unexpected skip。

- [ ] **Step 4: 运行敏感信息扫描**

```powershell
rg -n "accessToken|refreshToken|clientSecret|oneTimeToken|authorizationCode" src/modules/jifeng-connection src/components/integrations
```

人工核对每个命中：只允许字段名、schema、加密边界和 `type=password`；禁止 `console.*`、audit metadata、Action 返回、JSX text/value 中出现秘密。

- [ ] **Step 5: 验证并提交**

Run E2E、typecheck、lint、diff check。
Commit: `test: verify Jifeng authorization workflow`。

## Task 8: 发布前全量验证与只读生产联调

**Files:**
- Modify: this plan only to check completed boxes during execution
- No production secret files committed

- [ ] **Step 1: 全量本地门禁**

```powershell
npm.cmd test
npm.cmd run test:integration -- --maxWorkers 1
npm.cmd run test:e2e -- --workers 1
npm.cmd run typecheck
npm.cmd run lint
$env:DATABASE_URL='postgres://placeholder:placeholder@127.0.0.1:5432/placeholder_test'
$env:TEST_DATABASE_URL=$env:DATABASE_URL
$env:BETTER_AUTH_SECRET='0123456789abcdef0123456789abcdef'
$env:BETTER_AUTH_URL='http://127.0.0.1:3000'
npm.cmd run build
git diff --check
```

Expected: 全部 PASS；还原 build 产生的非任务 artifact。

- [ ] **Step 2: 安全代码审查**

审查 SSRF/域名覆盖、query secret 日志泄露、AES-GCM nonce、密钥长度、授权速率限制、事务/外部请求边界、refresh 并发、启用门绕过、普通管理员越权、断开/停用竞态。

- [ ] **Step 3: 部署迁移但保持关闭**

在服务器交互式写入密钥，不放入 shell history、聊天或 Git。备份数据库，运行 `0015` migration，重启新项目 web/worker。页面必须为“待授权”，履约关闭。

- [ ] **Step 4: 真实只读联调**

确认生产 WMS 域名；超级管理员取得 OMS 一次性授权 token，在后台完成授权；确认仓库和加拿大邮政候选；运行订单不存在查询。检查日志/审计不含 email、token、授权码或令牌。

- [ ] **Step 5: 保持真实履约关闭**

生产连接停留 `READY_DISABLED`。如果真实返回与官方 schema 有差异，只做最小、带契约测试的兼容修复并重跑 Step 1。首次真实推单等待用户另行确认。

Final commit（仅有联调修复时）：`fix: harden Jifeng production authorization`。

## Plan Self-Review

- Spec coverage: 凭据边界、官方授权协议、加密存储、资源发现、只读诊断、显式启用、refresh、停用/断开、审计、UI、worker、部署和只读生产验收均映射到 Task 1–8。
- Type consistency: 连接状态、`EncryptedSecret`、OAuth client、service、provider 和 action 接口在首次产出任务中定义，后续只消费这些名称。
- Scope: 不接极风库存、不修改飞书货盘迁移、不执行真实推单、不引入外部 KMS。
- Existing dirt: Task 1 明确接管当前 5 个未提交文件；其他任务开始前它们必须已独立提交。
- Placeholder scan: 通过；每项均包含明确文件、失败证据、实现边界、验证命令和提交点。

## Authoritative References

- 极风 API 使用说明：<https://s.apifox.cn/apidoc/docs-site/3972134/doc-3651609>
- 极风授权码接口：<https://s.apifox.cn/apidoc/docs-site/3972134/api-145133310>
- 极风 token 兑换接口：<https://s.apifox.cn/apidoc/docs-site/3972134/api-145133309>
- 极风 token 刷新接口：<https://s.apifox.cn/apidoc/docs-site/3972134/api-145133308>
- 极风客户物流渠道：<https://s.apifox.cn/apidoc/docs-site/3972134/api-145133306>
- 极风用户仓库：<https://s.apifox.cn/apidoc/docs-site/3972134/api-145133318>
- 本项目 Next.js 16 文档：`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`、`03-api-reference/04-functions/cookies.md`、`02-guides/server-actions.md`。
