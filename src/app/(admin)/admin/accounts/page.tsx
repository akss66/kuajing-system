import { DataWorkspaceToolbar } from "@/components/data-workspace/data-workspace-toolbar";
import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createAdminAccountAction,
  resetManagedAccountPasswordAction,
  setManagedAccountStatusAction,
  updateManagedAccountAction,
} from "@/modules/accounts/actions";
import { listManagedAccounts, type ManagedAccountSummary } from "@/modules/accounts/queries";
import { requireAdmin } from "@/modules/identity/guards";

function dateTime(value: Date | string | null) {
  if (!value) return "暂无记录";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(date);
}

function kindLabel(kind: ManagedAccountSummary["kind"]) {
  if (kind === "SUPER_ADMIN") return "超级管理员";
  if (kind === "ADMIN") return "普通管理员";
  return "客户账号";
}

function statusLabel(status: ManagedAccountSummary["status"]) {
  return status === "ACTIVE" ? "启用中" : "已停用";
}

function statusTone(status: ManagedAccountSummary["status"]) {
  return status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
}

function SummaryCard({
  count,
  description,
  title,
}: {
  count: number;
  description: string;
  title: string;
}) {
  return (
    <div className="rounded-[var(--radius-surface)] border border-border bg-background p-4">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-ink">{count}</p>
      <p className="mt-1 text-sm text-muted">{description}</p>
    </div>
  );
}

function ProtectedAccountNotice() {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-3 text-sm text-muted">
      该账号为系统初始化的超级管理员。这里只保留查看说明，不提供停用、降级、删除或重置入口。
    </div>
  );
}

function ManagedAccountActions({ account }: { account: ManagedAccountSummary }) {
  if (account.kind === "SUPER_ADMIN") {
    return <ProtectedAccountNotice />;
  }

  const nextStatus = account.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  const toggleLabel = nextStatus === "DISABLED" ? "停用账号" : "恢复账号";

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <ActionForm
        action={updateManagedAccountAction}
        className="grid gap-3 rounded-lg border border-border bg-surface p-3"
        submitLabel="保存资料"
      >
        <input name="userId" type="hidden" value={account.userId} />
        <label className="space-y-2 text-sm font-medium text-ink">
          姓名
          <Input className="min-h-11" defaultValue={account.displayName} name="displayName" required />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          账号邮箱
          <Input className="min-h-11" defaultValue={account.email} name="email" required type="email" />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          修改原因
          <Input className="min-h-11" name="reason" placeholder="例如：修正姓名或邮箱" required />
        </label>
      </ActionForm>

      <ActionForm
        action={resetManagedAccountPasswordAction}
        className="grid gap-3 rounded-lg border border-border bg-surface p-3"
        submitLabel="重置密码"
      >
        <input name="userId" type="hidden" value={account.userId} />
        <label className="space-y-2 text-sm font-medium text-ink">
          新密码
          <Input className="min-h-11" minLength={12} name="newPassword" placeholder="至少 12 位" required type="password" />
        </label>
        <label className="space-y-2 text-sm font-medium text-ink">
          重置原因
          <Input className="min-h-11" name="reason" placeholder="例如：重新发放初始密码" required />
        </label>
      </ActionForm>

      <ConfirmedActionForm
        action={setManagedAccountStatusAction}
        className="grid gap-3 rounded-lg border border-border bg-surface p-3"
        confirmDescription={
          nextStatus === "DISABLED"
            ? "停用后该账号的现有会话会立即失效，但历史订单、客户关系和审计日志不会删除。"
            : "恢复后该账号可以重新登录系统，原有数据和记录保持不变。"
        }
        confirmLabel={toggleLabel}
        confirmTitle={nextStatus === "DISABLED" ? "确认停用这个账号？" : "确认恢复这个账号？"}
        submitLabel={toggleLabel}
      >
        <input name="status" type="hidden" value={nextStatus} />
        <input name="userId" type="hidden" value={account.userId} />
        <label className="space-y-2 text-sm font-medium text-ink">
          操作原因
          <Input className="min-h-11" name="reason" placeholder="例如：离职停用 / 恢复值班账号" required />
        </label>
        <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-muted">
          当前状态：{statusLabel(account.status)}
        </div>
      </ConfirmedActionForm>
    </div>
  );
}

function DesktopAccountTable({ rows }: { rows: ManagedAccountSummary[] }) {
  return (
    <div className="hidden overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background lg:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>姓名</TableHead>
            <TableHead>邮箱</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>所属客户</TableHead>
            <TableHead>客户店铺数</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>最近登录</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.flatMap((account) => [
            <TableRow key={`${account.userId}-summary`}>
              <TableCell className="font-medium">
                <div className="space-y-1">
                  <p>{account.displayName}</p>
                  {account.kind === "SUPER_ADMIN" ? <p className="text-xs text-muted">受保护超级管理员</p> : null}
                </div>
              </TableCell>
              <TableCell>{account.email}</TableCell>
              <TableCell>{kindLabel(account.kind)}</TableCell>
              <TableCell>{account.customerName ?? "管理员账号"}</TableCell>
              <TableCell>{account.customerId ? `${account.storeCount} 家店铺` : "—"}</TableCell>
              <TableCell>
                <Badge className={statusTone(account.status)} variant="secondary">
                  {statusLabel(account.status)}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted">{dateTime(account.lastLoginAt)}</TableCell>
            </TableRow>,
            <TableRow key={`${account.userId}-actions`}>
              <TableCell className="bg-surface/60 px-3 py-4" colSpan={7}>
                <ManagedAccountActions account={account} />
              </TableCell>
            </TableRow>,
          ])}
        </TableBody>
      </Table>
    </div>
  );
}

function MobileAccountCards({ rows }: { rows: ManagedAccountSummary[] }) {
  return (
    <div className="space-y-4 lg:hidden">
      {rows.map((account) => (
        <article className="rounded-[var(--radius-surface)] border border-border bg-background" key={account.userId}>
          <div className="space-y-3 border-b border-border px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-ink">{account.displayName}</h3>
                <p className="mt-1 text-sm text-muted">{account.email}</p>
              </div>
              <Badge className={statusTone(account.status)} variant="secondary">
                {statusLabel(account.status)}
              </Badge>
            </div>
            <dl className="grid gap-2 text-sm text-muted sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-[0.08em]">角色</dt>
                <dd className="mt-1 text-ink">{kindLabel(account.kind)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-[0.08em]">所属客户</dt>
                <dd className="mt-1 text-ink">{account.customerName ?? "管理员账号"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-[0.08em]">店铺覆盖</dt>
                <dd className="mt-1 text-ink">{account.customerId ? `${account.storeCount} 家店铺` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-[0.08em]">最近登录</dt>
                <dd className="mt-1 text-ink">{dateTime(account.lastLoginAt)}</dd>
              </div>
            </dl>
          </div>
          <div className="px-4 py-4">
            <ManagedAccountActions account={account} />
          </div>
        </article>
      ))}
    </div>
  );
}

function AccountSection({
  description,
  emptyCopy,
  rows,
  title,
}: {
  description: string;
  emptyCopy: string;
  rows: ManagedAccountSummary[];
  title: string;
}) {
  return (
    <section className="space-y-4">
      <DataWorkspaceToolbar description={description} title={title} />
      {rows.length ? (
        <>
          <DesktopAccountTable rows={rows} />
          <MobileAccountCards rows={rows} />
        </>
      ) : (
        <div className="rounded-[var(--radius-surface)] border border-border bg-background px-5 py-12 text-center text-sm text-muted">
          {emptyCopy}
        </div>
      )}
    </section>
  );
}

function AccessDeniedState() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">账号管理受限</h1>
        <p className="text-sm text-muted">只有超级管理员可以查看、创建或停用账号。</p>
      </header>
      <section className="rounded-[var(--radius-surface)] border border-warning/25 bg-warning/5 px-5 py-5 text-sm text-warning">
        普通管理员仍可继续处理客户与店铺的日常管理，但账号治理操作不会在这里暴露。
      </section>
    </div>
  );
}

export default async function AccountsPage() {
  const principal = await requireAdmin();
  if (principal.kind !== "SUPER_ADMIN") {
    return <AccessDeniedState />;
  }

  const rows = await listManagedAccounts();
  const adminAccounts = rows.filter((account) => account.kind !== "CUSTOMER");
  const customerAccounts = rows.filter((account) => account.kind === "CUSTOMER");

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">账号管理</h1>
        <p className="text-sm text-muted">
          超级管理员在这里集中维护内部管理员与客户账号，所有停用和重置操作都会保留原有审计记录。
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <SummaryCard count={adminAccounts.length} description="包含受保护超级管理员与普通管理员。" title="管理员账号" />
        <SummaryCard count={customerAccounts.length} description="一位客户绑定唯一账号，直接覆盖其名下店铺。" title="客户账号" />
        <SummaryCard count={customerAccounts.filter((item) => item.status === "DISABLED").length} description="停用后旧会话立即失效，历史订单不会删除。" title="已停用账号" />
        <SummaryCard count={customerAccounts.reduce((sum, item) => sum + item.storeCount, 0)} description="客户账号下的店铺数总和，用于快速判断覆盖范围。" title="客户店铺数" />
      </div>

      <Tabs className="gap-5" defaultValue="admins">
        <TabsList variant="line">
          <TabsTrigger value="admins">管理员账号</TabsTrigger>
          <TabsTrigger value="customers">客户账号</TabsTrigger>
        </TabsList>

        <TabsContent className="space-y-5" value="admins">
          <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
            <h2 className="text-lg font-semibold text-ink">创建普通管理员</h2>
            <p className="mt-1 text-sm text-muted">此入口只允许创建普通管理员，不提供创建或晋升超级管理员的能力。</p>
            <ActionForm
              action={createAdminAccountAction}
              className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.2fr_1fr_1.4fr_auto] xl:items-end"
              submitLabel="创建管理员账号"
            >
              <label className="space-y-2 text-sm font-medium text-ink">
                管理员姓名
                <Input className="min-h-11" name="displayName" placeholder="例如：运营值班管理员" required />
              </label>
              <label className="space-y-2 text-sm font-medium text-ink">
                登录邮箱
                <Input className="min-h-11" name="email" placeholder="ops@example.com" required type="email" />
              </label>
              <label className="space-y-2 text-sm font-medium text-ink">
                初始密码
                <Input className="min-h-11" minLength={12} name="password" placeholder="至少 12 位" required type="password" />
              </label>
              <label className="space-y-2 text-sm font-medium text-ink">
                创建原因
                <Input className="min-h-11" name="reason" placeholder="例如：新增白班值守管理员" required />
              </label>
            </ActionForm>
          </section>

          <AccountSection
            description="超级管理员行仅保留查看说明；普通管理员可修改资料、重置密码并停用或恢复。"
            emptyCopy="暂无管理员账号。创建后将自动进入管理员账号列表。"
            rows={adminAccounts}
            title="管理员账号清单"
          />
        </TabsContent>

        <TabsContent className="space-y-5" value="customers">
          <AccountSection
            description="客户账号与所属客户一一对应，可直接查看客户名称、店铺覆盖数和最近登录。"
            emptyCopy="暂无客户账号。客户创建后会自动绑定唯一登录账号。"
            rows={customerAccounts}
            title="客户账号清单"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
