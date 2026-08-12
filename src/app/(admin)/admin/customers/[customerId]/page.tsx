import type { ReactNode } from "react";

import { AlertTriangle } from "lucide-react";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createStoreAction,
  setCustomerStatusAction,
  setStoreStatusAction,
  updateCustomerAction,
  updateStoreAction,
} from "@/modules/customers/actions";
import { getCustomerManagementDetail } from "@/modules/customers/queries";

type CustomerDetail = Awaited<ReturnType<typeof getCustomerManagementDetail>>;
type ManagedStore = CustomerDetail["stores"][number];

function statusTone(status: "ACTIVE" | "DISABLED") {
  return status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
}

function statusLabel(status: "ACTIVE" | "DISABLED") {
  return status === "ACTIVE" ? "启用中" : "已停用";
}

function DangerHint({
  children,
  tone = "warning",
}: {
  children: ReactNode;
  tone?: "muted" | "warning";
}) {
  return (
    <div
      className={
        tone === "warning"
          ? "rounded-lg border border-warning/25 bg-warning/5 px-3 py-3 text-sm text-warning"
          : "rounded-lg border border-border bg-surface px-3 py-3 text-sm text-muted"
      }
    >
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{children}</p>
      </div>
    </div>
  );
}

function CustomerStatusForm({
  customerId,
  status,
}: {
  customerId: string;
  status: "ACTIVE" | "DISABLED";
}) {
  const nextStatus = status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  const submitLabel = nextStatus === "DISABLED" ? "停用客户" : "恢复客户";

  return (
    <ConfirmedActionForm
      action={setCustomerStatusAction}
      className="grid gap-3 rounded-lg border border-border bg-background p-4"
      confirmDescription={
        nextStatus === "DISABLED"
          ? "停用客户后，唯一登录账号会同步停用并撤销当前会话，但历史订单、店铺与审计记录会被保留。"
          : "恢复客户后，唯一登录账号与所属店铺会重新恢复正常使用。"
      }
      confirmLabel={submitLabel}
      confirmTitle={nextStatus === "DISABLED" ? "确认停用该客户？" : "确认恢复该客户？"}
      submitLabel={submitLabel}
    >
      <input name="customerId" type="hidden" value={customerId} />
      <input name="status" type="hidden" value={nextStatus} />
      <label className="space-y-2 text-sm font-medium text-ink">
        操作原因
        <Input className="min-h-11" name="reason" placeholder="例如：合作暂停 / 恢复发货" required />
      </label>
      <DangerHint tone="muted">当前状态：{statusLabel(status)}。停用不会删除客户与店铺数据。</DangerHint>
    </ConfirmedActionForm>
  );
}

function StoreUpdateForm({
  customerId,
  store,
}: {
  customerId: string;
  store: ManagedStore;
}) {
  return (
    <ActionForm action={updateStoreAction} className="grid gap-3" submitLabel="保存店铺资料">
      <input name="customerId" type="hidden" value={customerId} />
      <input name="storeId" type="hidden" value={store.id} />
      <label className="space-y-2 text-sm font-medium text-ink">
        店铺名称
        <Input className="min-h-11" defaultValue={store.name} name="name" required />
      </label>
      <label className="space-y-2 text-sm font-medium text-ink">
        平台
        <Input className="min-h-11" defaultValue={store.platform} name="platform" required />
      </label>
      <label className="space-y-2 text-sm font-medium text-ink">
        外部店铺编号
        <Input
          className="min-h-11"
          defaultValue={store.externalStoreCode ?? ""}
          name="externalStoreCode"
        />
      </label>
      <label className="space-y-2 text-sm font-medium text-ink">
        修改原因
        <Input className="min-h-11" name="reason" placeholder="例如：修正平台名称或门店编号" required />
      </label>
    </ActionForm>
  );
}

function StoreStatusForm({
  customerId,
  store,
}: {
  customerId: string;
  store: ManagedStore;
}) {
  const nextStatus = store.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  const submitLabel = nextStatus === "DISABLED" ? "停用店铺" : "恢复店铺";

  return (
    <ConfirmedActionForm
      action={setStoreStatusAction}
      className="grid gap-3"
      confirmDescription={
        nextStatus === "DISABLED"
          ? "停用后该店铺不能再新建拿货单，但历史订单、结算和审计记录会完整保留。"
          : "恢复后该店铺可重新导入订单并发起新的拿货流程。"
      }
      confirmLabel={submitLabel}
      confirmTitle={nextStatus === "DISABLED" ? "确认停用这家店铺？" : "确认恢复这家店铺？"}
      submitLabel={submitLabel}
    >
      <input name="customerId" type="hidden" value={customerId} />
      <input name="storeId" type="hidden" value={store.id} />
      <input name="status" type="hidden" value={nextStatus} />
      <label className="space-y-2 text-sm font-medium text-ink">
        操作原因
        <Input className="min-h-11" name="reason" placeholder="例如：暂停接单 / 恢复营业" required />
      </label>
      <DangerHint tone="muted">
        当前状态：{statusLabel(store.status)}。停用不会清空该店铺历史业务数据。
      </DangerHint>
    </ConfirmedActionForm>
  );
}

function DesktopStoreRows({
  customerId,
  store,
}: {
  customerId: string;
  store: ManagedStore;
}) {
  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{store.name}</TableCell>
        <TableCell>{store.platform}</TableCell>
        <TableCell>{store.externalStoreCode ?? "暂无记录"}</TableCell>
        <TableCell>
          <Badge className={statusTone(store.status)} variant="secondary">
            {statusLabel(store.status)}
          </Badge>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell className="bg-surface/60 px-3 py-4" colSpan={4}>
          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.9fr]">
            <div className="rounded-lg border border-border bg-background p-3">
              <StoreUpdateForm customerId={customerId} store={store} />
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <StoreStatusForm customerId={customerId} store={store} />
            </div>
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}

function MobileStoreCard({
  customerId,
  store,
}: {
  customerId: string;
  store: ManagedStore;
}) {
  return (
    <details className="rounded-[var(--radius-surface)] border border-border bg-background">
      <summary className="cursor-pointer list-none px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div>
              <p className="text-base font-semibold text-ink">{store.name}</p>
              <p className="mt-1 text-sm text-muted">{store.platform}</p>
            </div>
            <div className="grid gap-1 text-sm text-muted">
              <p>外部编号：{store.externalStoreCode ?? "暂无记录"}</p>
              <p>状态：{statusLabel(store.status)}</p>
            </div>
          </div>
          <div className="space-y-2 text-right">
            <Badge className={statusTone(store.status)} variant="secondary">
              {statusLabel(store.status)}
            </Badge>
            <p className="text-sm font-medium text-brand-primary">编辑店铺</p>
          </div>
        </div>
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-4">
        <div className="rounded-lg border border-border bg-surface p-3">
          <StoreUpdateForm customerId={customerId} store={store} />
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <StoreStatusForm customerId={customerId} store={store} />
        </div>
      </div>
    </details>
  );
}

export default async function CustomerDetailPage(props: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await props.params;

  let detail: CustomerDetail;
  try {
    detail = await getCustomerManagementDetail(customerId);
  } catch (error) {
    if (error instanceof Error && error.message === "CUSTOMER_NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">客户详情</h1>
          <Badge className={statusTone(detail.customer.status)} variant="secondary">
            {statusLabel(detail.customer.status)}
          </Badge>
        </div>
        <p className="text-sm text-muted">
          {detail.customer.code} · 管理客户资料、唯一账号摘要，以及名下多家店铺的启停与资料维护。
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="rounded-[var(--radius-surface)] border border-border bg-background p-4">
          <p className="text-xs uppercase tracking-[0.08em] text-muted">客户状态</p>
          <p className="mt-2 text-lg font-semibold text-ink">{statusLabel(detail.customer.status)}</p>
        </div>
        <div className="rounded-[var(--radius-surface)] border border-border bg-background p-4">
          <p className="text-xs uppercase tracking-[0.08em] text-muted">店铺数量</p>
          <p className="mt-2 text-lg font-semibold text-ink">{detail.stores.length}</p>
        </div>
        <div className="rounded-[var(--radius-surface)] border border-border bg-background p-4">
          <p className="text-xs uppercase tracking-[0.08em] text-muted">客户账号</p>
          <p className="mt-2 text-lg font-semibold text-ink">{detail.account ? "已绑定" : "待排查"}</p>
        </div>
        <div className="rounded-[var(--radius-surface)] border border-border bg-background p-4">
          <p className="text-xs uppercase tracking-[0.08em] text-muted">联系微信</p>
          <p className="mt-2 text-lg font-semibold text-ink">
            {detail.customer.contactWechat || "暂无记录"}
          </p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="space-y-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
          <div>
            <h2 className="text-lg font-semibold text-ink">客户资料</h2>
            <p className="mt-1 text-sm text-muted">修改客户编号、名称、联系人与微信后，会同步写入审计日志。</p>
          </div>
          <ActionForm
            action={updateCustomerAction}
            className="grid gap-4 md:grid-cols-2"
            submitLabel="保存客户资料"
          >
            <input name="customerId" type="hidden" value={detail.customer.id} />
            <label className="space-y-2 text-sm font-medium text-ink">
              客户编号
              <Input className="min-h-11" defaultValue={detail.customer.code} name="code" required />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              客户名称
              <Input className="min-h-11" defaultValue={detail.customer.name} name="name" required />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              联系人
              <Input
                className="min-h-11"
                defaultValue={detail.customer.contactName ?? ""}
                name="contactName"
              />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              微信
              <Input
                className="min-h-11"
                defaultValue={detail.customer.contactWechat ?? ""}
                name="contactWechat"
              />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink md:col-span-2">
              修改原因
              <Input className="min-h-11" name="reason" placeholder="例如：更新联系人与微信信息" required />
            </label>
          </ActionForm>
        </section>

        <div className="space-y-4">
          <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">唯一客户账号</h2>
                <p className="mt-1 text-sm text-muted">每位客户仅绑定一个登录账号，这里只提供摘要，不新增第二个入口。</p>
              </div>
              {detail.account ? (
                <Badge className={statusTone(detail.account.status)} variant="secondary">
                  {statusLabel(detail.account.status)}
                </Badge>
              ) : null}
            </div>
            {detail.account ? (
              <div className="mt-4 space-y-2 rounded-lg border border-border bg-surface px-4 py-4">
                <label className="space-y-2 text-sm font-medium text-ink">
                  账号姓名
                  <Input className="min-h-11 bg-background" defaultValue={detail.account.displayName} readOnly />
                </label>
                <label className="space-y-2 text-sm font-medium text-ink">
                  账号邮箱
                  <Input className="min-h-11 bg-background" defaultValue={detail.account.email} readOnly />
                </label>
                <p className="text-sm text-muted">账号状态：{statusLabel(detail.account.status)}</p>
              </div>
            ) : (
              <DangerHint>当前客户尚未同步出可登录账号，请先排查初始化或治理流程。</DangerHint>
            )}
          </section>

          <CustomerStatusForm customerId={detail.customer.id} status={detail.customer.status} />
        </div>
      </div>

      <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-ink">新增店铺</h2>
        <p className="mt-1 text-sm text-muted">支持同一客户新增多家 TEMU 店铺，并保留各店铺独立的启停状态。</p>
        <ActionForm
          action={createStoreAction}
          className="mt-4 grid gap-4 xl:grid-cols-[1fr_0.9fr_1fr_1.2fr_auto] xl:items-end"
          submitLabel="新增店铺"
        >
          <input name="customerId" type="hidden" value={detail.customer.id} />
          <label className="space-y-2 text-sm font-medium text-ink">
            店铺名称
            <Input className="min-h-11" name="name" placeholder="例如：华北二店" required />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            平台
            <Input className="min-h-11" defaultValue="TEMU" name="platform" required />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            外部店铺编号
            <Input className="min-h-11" name="externalStoreCode" placeholder="例如：TEMU-NORTH-002" />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            创建原因
            <Input className="min-h-11" name="reason" placeholder="例如：新增第二家店铺接单" required />
          </label>
        </ActionForm>
      </section>

      <section className="space-y-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
        <div>
          <h2 className="text-lg font-semibold text-ink">店铺清单</h2>
          <p className="mt-1 text-sm text-muted">桌面端保留高密度直接编辑，移动端改为摘要卡折叠展开，避免长表单直出。</p>
        </div>

        {detail.stores.length ? (
          <>
            <div className="hidden overflow-hidden rounded-[var(--radius-surface)] border border-border lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>店铺名称</TableHead>
                    <TableHead>平台</TableHead>
                    <TableHead>外部店铺编号</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.stores.map((store) => (
                    <DesktopStoreRows customerId={detail.customer.id} key={store.id} store={store} />
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-4 lg:hidden">
              {detail.stores.map((store) => (
                <MobileStoreCard customerId={detail.customer.id} key={store.id} store={store} />
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-[var(--radius-surface)] border border-dashed border-border px-5 py-10 text-center text-sm text-muted">
            当前客户还没有店铺，使用上方表单新增第一家店铺。
          </div>
        )}
      </section>
    </div>
  );
}
