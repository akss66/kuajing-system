import { notFound } from "next/navigation";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  createStoreAction,
  setCustomerStatusAction,
  setStoreStatusAction,
  updateCustomerAction,
  updateStoreAction,
} from "@/modules/customers/actions";
import { getCustomerManagementDetail } from "@/modules/customers/queries";

function statusTone(status: "ACTIVE" | "DISABLED") {
  return status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
}

function statusLabel(status: "ACTIVE" | "DISABLED") {
  return status === "ACTIVE" ? "启用中" : "已停用";
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
      className="grid gap-3 rounded-lg border border-border bg-surface p-4"
      confirmDescription={
        nextStatus === "DISABLED"
          ? "停用客户后，该客户账号会同步停用并撤销当前会话，但历史订单与店铺数据不会删除。"
          : "恢复客户后，该客户账号与店铺可重新进入正常运营。"
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
      <div className="rounded-lg border border-border bg-background px-3 py-3 text-sm text-muted">
        当前状态：{statusLabel(status)}
      </div>
    </ConfirmedActionForm>
  );
}

function StoreManagementRow({
  customerId,
  store,
}: {
  customerId: string;
  store: Awaited<ReturnType<typeof getCustomerManagementDetail>>["stores"][number];
}) {
  const nextStatus = store.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  const submitLabel = nextStatus === "DISABLED" ? "停用店铺" : "恢复店铺";

  return [
    <TableRow key={`${store.id}-summary`}>
      <TableCell className="font-medium">{store.name}</TableCell>
      <TableCell>{store.platform}</TableCell>
      <TableCell>{store.externalStoreCode ?? "—"}</TableCell>
      <TableCell>
        <Badge className={statusTone(store.status)} variant="secondary">
          {statusLabel(store.status)}
        </Badge>
      </TableCell>
    </TableRow>,
    <TableRow key={`${store.id}-actions`}>
      <TableCell className="bg-surface/60 px-3 py-4" colSpan={4}>
        <div className="grid gap-4 xl:grid-cols-2">
          <ActionForm
            action={updateStoreAction}
            className="grid gap-3 rounded-lg border border-border bg-background p-3"
            submitLabel="保存店铺资料"
          >
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
              <Input className="min-h-11" defaultValue={store.externalStoreCode ?? ""} name="externalStoreCode" />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              修改原因
              <Input className="min-h-11" name="reason" placeholder="例如：修正平台名称或编码" required />
            </label>
          </ActionForm>

          <ConfirmedActionForm
            action={setStoreStatusAction}
            className="grid gap-3 rounded-lg border border-border bg-background p-3"
            confirmDescription={
              nextStatus === "DISABLED"
                ? "停用后该店铺不能再新建拿货单，但历史订单、结算和日志会全部保留。"
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
            <div className="rounded-lg border border-border bg-surface px-3 py-3 text-sm text-muted">
              当前状态：{statusLabel(store.status)}
            </div>
          </ConfirmedActionForm>
        </div>
      </TableCell>
    </TableRow>,
  ];
}

export default async function CustomerDetailPage(props: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await props.params;

  let detail: Awaited<ReturnType<typeof getCustomerManagementDetail>>;
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
          {detail.customer.code} · 管理客户资料、唯一账号摘要，以及名下多家店铺的启用和停用状态。
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="space-y-4 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-5">
          <div>
            <h2 className="text-lg font-semibold text-ink">客户资料</h2>
            <p className="mt-1 text-sm text-muted">修改客户编号、名称、联系人与微信后，会同步进入审计日志。</p>
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
              <Input className="min-h-11" defaultValue={detail.customer.contactName ?? ""} name="contactName" />
            </label>
            <label className="space-y-2 text-sm font-medium text-ink">
              微信
              <Input className="min-h-11" defaultValue={detail.customer.contactWechat ?? ""} name="contactWechat" />
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
                <p className="mt-1 text-sm text-muted">客户账号与当前客户一一对应，不在这里额外创建第二个登录入口。</p>
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
              <div className="mt-4 rounded-lg border border-warning/25 bg-warning/5 px-4 py-4 text-sm text-warning">
                当前客户尚未同步可登录账号，请先排查初始化流程。
              </div>
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

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <h2 className="text-lg font-semibold text-ink">店铺清单</h2>
          <p className="mt-1 text-sm text-muted">桌面端保持高密度编辑，移动端会改为信息分组而不是缩小字号。</p>
        </div>
        {detail.stores.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>店铺名称</TableHead>
                <TableHead>平台</TableHead>
                <TableHead>外部店铺编号</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{detail.stores.flatMap((store) => StoreManagementRow({ customerId: detail.customer.id, store }))}</TableBody>
          </Table>
        ) : (
          <div className="px-5 py-12 text-center text-sm text-muted">当前客户还没有店铺，使用上方表单新增第一家店铺。</div>
        )}
      </section>
    </div>
  );
}
