"use client";

import {
  ArrowDownLeft,
  ArrowUpRight,
  ExternalLink,
  Pencil,
  ShoppingBag,
  Store as StoreIcon,
  UserRound,
  WalletCards,
} from "lucide-react";
import Link from "next/link";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { DangerZone } from "@/components/management/danger-zone";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  setCustomerStatusAction,
  updateCustomerAction,
} from "@/modules/customers/actions";
import type { getCustomerManagementDetail } from "@/modules/customers/queries";
import { getAdminSettlementOrderStatusLabel } from "@/modules/settlement/admin-ui-labels";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import { StoreManagementDrawer } from "./store-management-drawer";

type CustomerDetail = Awaited<ReturnType<typeof getCustomerManagementDetail>>;
type ManagedCustomer = CustomerDetail["customer"];

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  currency: "CNY",
  minimumFractionDigits: 2,
  style: "currency",
});
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: BUSINESS_TIME_ZONE,
});

function money(fen: number) {
  return moneyFormatter.format(fen / 100);
}

function dateTime(value: Date) {
  return dateTimeFormatter.format(value);
}

function statusLabel(status: "ACTIVE" | "DISABLED") {
  return status === "ACTIVE" ? "启用中" : "已停用";
}

function StatusBadge({ status }: { status: "ACTIVE" | "DISABLED" }) {
  return (
    <Badge
      className={status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}
      variant="secondary"
    >
      {statusLabel(status)}
    </Badge>
  );
}

function CustomerProfileForm({ customer }: { customer: ManagedCustomer }) {
  return (
    <ActionForm action={updateCustomerAction} className="grid gap-4" submitLabel="保存客户资料">
      <input name="customerId" type="hidden" value={customer.id} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        客户编号
        <Input className="min-h-11" defaultValue={customer.code} maxLength={40} name="code" required />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        客户名称
        <Input className="min-h-11" defaultValue={customer.name} maxLength={160} name="name" required />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        联系人
        <Input className="min-h-11" defaultValue={customer.contactName ?? ""} maxLength={120} name="contactName" />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        微信
        <Input className="min-h-11" defaultValue={customer.contactWechat ?? ""} maxLength={120} name="contactWechat" />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        修改原因
        <Input className="min-h-11" maxLength={500} name="reason" placeholder="例如：更新联系人与微信信息" required />
      </label>
    </ActionForm>
  );
}

function CustomerStatusForm({ customer }: { customer: ManagedCustomer }) {
  const disabling = customer.status === "ACTIVE";
  const nextStatus = disabling ? "DISABLED" : "ACTIVE";
  const actionLabel = disabling ? "停用客户" : "恢复客户";

  return (
    <ConfirmedActionForm
      action={setCustomerStatusAction}
      className="grid gap-4"
      confirmDescription={
        disabling
          ? `停用 ${customer.name} 后，唯一登录账号会同步停用并撤销现有会话；历史业务数据会完整保留。`
          : `恢复 ${customer.name} 后，唯一登录账号可以重新登录；历史数据和审计记录保持不变。`
      }
      confirmLabel={actionLabel}
      confirmTitle={disabling ? "确认停用该客户？" : "确认恢复该客户？"}
      submitLabel={actionLabel}
    >
      <input name="customerId" type="hidden" value={customer.id} />
      <input name="status" type="hidden" value={nextStatus} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        操作原因
        <Input className="min-h-11" maxLength={500} name="reason" placeholder={disabling ? "例如：合作暂停" : "例如：恢复合作"} required />
      </label>
    </ConfirmedActionForm>
  );
}

function CustomerEditDrawer({
  canManageCustomerStatus,
  customer,
}: {
  canManageCustomerStatus: boolean;
  customer: ManagedCustomer;
}) {
  return (
    <EntityDrawer
      description="客户资料维护与启停操作分区呈现。"
      size="lg"
      title="编辑客户"
      trigger={
        <Button className="min-h-11">
          <Pencil aria-hidden="true" />
          编辑客户
        </Button>
      }
    >
      <DrawerSection description="更新客户身份与联系方式，所有变更都需要填写原因。" title="基本资料">
        <CustomerProfileForm customer={customer} />
      </DrawerSection>
      {canManageCustomerStatus ? (
        <DangerZone
          description={
            customer.status === "ACTIVE"
              ? "停用将同步关闭客户登录并撤销现有会话；必须填写审计原因并再次确认。"
              : "恢复后客户账号可以重新登录；必须填写审计原因并再次确认。"
          }
        >
          <CustomerStatusForm customer={customer} />
        </DangerZone>
      ) : null}
    </EntityDrawer>
  );
}

function OverviewTab({
  canGovernAccounts,
  detail,
}: {
  canGovernAccounts: boolean;
  detail: CustomerDetail;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
      <WorkspacePanel aria-labelledby="customer-profile-heading" className="p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <UserRound aria-hidden="true" className="size-4 text-primary" />
          <h2 className="font-semibold text-foreground" id="customer-profile-heading">客户资料</h2>
        </div>
        <dl className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <ProfileFact label="客户编号" value={detail.customer.code} />
          <ProfileFact label="客户名称" value={detail.customer.name} />
          <ProfileFact label="联系人" value={detail.customer.contactName ?? "暂无记录"} />
          <ProfileFact label="微信" value={detail.customer.contactWechat ?? "暂无记录"} />
        </dl>
      </WorkspacePanel>

      <WorkspacePanel aria-labelledby="customer-account-heading" className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground" id="customer-account-heading">唯一登录账号</h2>
            <p className="mt-1 text-sm text-muted-foreground">登录身份只在账号管理中维护。</p>
          </div>
          {detail.account ? <StatusBadge status={detail.account.status} /> : null}
        </div>
        {detail.account ? (
          <dl className="mt-5 space-y-4">
            <ProfileFact label="账号姓名" value={detail.account.displayName} />
            <ProfileFact label="账号邮箱" value={detail.account.email} />
          </dl>
        ) : (
          <p className="mt-5 text-sm text-warning">尚未同步可登录账号，请前往账号管理排查。</p>
        )}
        {canGovernAccounts ? (
          <Button asChild className="mt-5 min-h-11 w-full sm:w-auto" variant="outline">
            <Link href={`/admin/accounts?customerId=${detail.customer.id}`}>
              前往账号管理
              <ExternalLink aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </WorkspacePanel>
    </div>
  );
}

function ProfileFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

function StoresTab({ detail }: { detail: CustomerDetail }) {
  return (
    <WorkspacePanel className="overflow-hidden">
      <WorkspacePanelHeader
        action={<StoreManagementDrawer customerId={detail.customer.id} />}
        description="选择一家店铺打开管理抽屉；资料与危险操作不会在列表中展开。"
        title="店铺清单"
      />
      {detail.stores.length ? (
        <div>
          <div className="hidden grid-cols-[minmax(0,1.4fr)_0.7fr_1fr_0.6fr_auto] gap-4 border-b border-border bg-muted/35 px-5 py-2.5 text-xs font-semibold text-muted-foreground lg:grid">
            <span>店铺</span><span>平台</span><span>外部编号</span><span>状态</span><span>操作</span>
          </div>
          <ul aria-label="店铺清单" className="divide-y divide-border">
            {detail.stores.map((store) => (
              <li className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(0,1.4fr)_0.7fr_1fr_0.6fr_auto] lg:items-center lg:px-5" key={store.id}>
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{store.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground lg:hidden">{store.platform} · {store.externalStoreCode ?? "暂无外部编号"}</p>
                </div>
                <span className="hidden text-sm text-foreground lg:block">{store.platform}</span>
                <span className="hidden truncate text-sm tabular-nums text-muted-foreground lg:block">{store.externalStoreCode ?? "暂无记录"}</span>
                <StatusBadge status={store.status} />
                <StoreManagementDrawer customerId={detail.customer.id} store={store} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <EmptyState description="新增第一家店铺后，可在这里维护资料与启停状态。" title="当前客户还没有店铺" />
      )}
    </WorkspacePanel>
  );
}

function OrdersTab({ orders }: { orders: CustomerDetail["recentOrders"] }) {
  return (
    <WorkspacePanel className="overflow-hidden">
      <WorkspacePanelHeader description="按提交时间显示最近 20 单；进入订单详情可继续查看履约与补发。" title="近期订单与补发入口" />
      {orders.length ? (
        <ul aria-label="近期订单" className="divide-y divide-border">
          {orders.map((order) => (
            <li className="grid min-w-0 gap-3 p-4 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] sm:items-center sm:px-5" key={order.id}>
              <div className="min-w-0">
                <Link className="font-medium text-primary hover:underline" href={`/admin/orders/${order.id}`}>{order.orderNumber}</Link>
                <p className="mt-1 truncate text-xs text-muted-foreground">{order.storeName} · {dateTime(order.submittedAt)}（渥太华）</p>
              </div>
              <Badge className="w-fit" variant="secondary">{getAdminSettlementOrderStatusLabel(order.status)}</Badge>
              <div className="sm:text-right">
                <p className="font-semibold tabular-nums text-foreground">{money(order.netAmountFen)}</p>
                {order.adjustedAmountFen > 0 ? (
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    原始金额 {money(order.totalAmountFen)}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState description="客户提交拿货单后，最近记录会显示在这里。" title="暂无订单记录" />
      )}
    </WorkspacePanel>
  );
}

const transactionLabels = {
  ADMIN_CREDIT: "管理员充值",
  ADMIN_DEBIT: "管理员扣减",
  ORDER_DEBIT: "订单扣款",
  ORDER_REFUND: "订单退款",
} as const;

function TransactionsTab({ transactions }: { transactions: CustomerDetail["recentTransactions"] }) {
  return (
    <WorkspacePanel className="overflow-hidden">
      <WorkspacePanelHeader description="按发生时间显示最近 20 笔，不在客户详情中提供资金写入操作。" title="资金记录" />
      {transactions.length ? (
        <ul aria-label="资金记录" className="divide-y divide-border">
          {transactions.map((transaction) => (
            <li className="flex min-w-0 items-start gap-3 p-4 sm:px-5" key={transaction.id}>
              <span className={`flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] ${transaction.deltaFen > 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                {transaction.deltaFen > 0 ? <ArrowDownLeft aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{transaction.reason}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{transactionLabels[transaction.transactionType]} · {dateTime(transaction.createdAt)}（渥太华）</p>
                  </div>
                  <p className={`shrink-0 font-semibold tabular-nums ${transaction.deltaFen > 0 ? "text-success" : "text-destructive"}`}>
                    {transaction.deltaFen > 0 ? "+" : "−"}{money(Math.abs(transaction.deltaFen))}
                  </p>
                </div>
                <p className="mt-2 text-xs tabular-nums text-muted-foreground">变动后余额 {money(transaction.afterBalanceFen)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState description="充值、扣款或退款发生后，最近记录会显示在这里。" title="暂无资金记录" />
      )}
    </WorkspacePanel>
  );
}

function EmptyState({ description, title }: { description: string; title: string }) {
  return (
    <div className="px-5 py-14 text-center" role="status">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function CustomerDetailWorkspace({
  canManageCustomerStatus = true,
  canGovernAccounts = true,
  detail,
}: {
  canManageCustomerStatus?: boolean;
  canGovernAccounts?: boolean;
  detail: CustomerDetail;
}) {
  return (
    <div className="min-w-0 space-y-5">
      <PageHeading
        action={
          <div className="flex items-center gap-3">
            <StatusBadge status={detail.customer.status} />
            <CustomerEditDrawer
              canManageCustomerStatus={canManageCustomerStatus}
              customer={detail.customer}
            />
          </div>
        }
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { href: "/admin/customers", label: "客户与店铺" },
          { label: "客户详情" },
        ]}
        description={`${detail.customer.code} · 客户资料默认只读，编辑与启停操作在抽屉中完成。`}
        title={detail.customer.name}
      />

      <MetricStrip
        items={[
          { hint: "客户账户账面余额", label: "可用余额", value: money(detail.summary.balanceFen) },
          { hint: "当前客户名下店铺", label: "店铺数量", value: `${detail.summary.storeCount} 家` },
          { hint: "待付款订单金额", label: "待付款", tone: detail.summary.pendingPaymentFen ? "warning" : "default", value: money(detail.summary.pendingPaymentFen) },
          { hint: "最近 30 天已提交", label: "近期订单", value: `${detail.summary.recentOrderCount} 单` },
        ]}
      />

      <Tabs className="min-w-0 gap-4" defaultValue="overview">
        <div className="max-w-full border-b border-border">
          <TabsList className="!grid min-h-11 w-full grid-cols-2 p-0 sm:!inline-flex sm:w-fit" variant="line">
            <TabsTrigger className="min-h-11 px-3" value="overview"><UserRound aria-hidden="true" />概览</TabsTrigger>
            <TabsTrigger className="min-h-11 px-3" value="stores"><StoreIcon aria-hidden="true" />店铺</TabsTrigger>
            <TabsTrigger className="min-h-11 px-3" value="orders"><ShoppingBag aria-hidden="true" />订单与补发</TabsTrigger>
            <TabsTrigger className="min-h-11 px-3" value="transactions"><WalletCards aria-hidden="true" />资金记录</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab canGovernAccounts={canGovernAccounts} detail={detail} />
        </TabsContent>
        <TabsContent value="stores"><StoresTab detail={detail} /></TabsContent>
        <TabsContent value="orders"><OrdersTab orders={detail.recentOrders} /></TabsContent>
        <TabsContent value="transactions"><TransactionsTab transactions={detail.recentTransactions} /></TabsContent>
      </Tabs>
    </div>
  );
}
