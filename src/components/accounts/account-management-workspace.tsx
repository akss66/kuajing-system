"use client";

import { LockKeyhole, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ManagedAccountSummary } from "@/modules/accounts/queries";

import { CreateAdminForm } from "./create-admin-form";
import { ManagedAccountDrawerContent } from "./managed-account-drawer-content";
import { accountKindLabel, accountStatusLabel, formatAccountDateTime } from "./workspace-copy";

type AccountTab = "admins" | "customers" | "disabled";
type RoleFilter = "ALL" | ManagedAccountSummary["kind"];
type StatusFilter = "ALL" | ManagedAccountSummary["status"];

const tabs: { label: string; value: AccountTab }[] = [
  { label: "管理员账号", value: "admins" },
  { label: "客户账号", value: "customers" },
  { label: "已停用", value: "disabled" },
];

function accountStatusTone(status: ManagedAccountSummary["status"]) {
  return status === "ACTIVE" ? "bg-success/10 text-success" : "bg-warning/10 text-warning";
}

function AccountDetailTrigger({ account }: { account: ManagedAccountSummary }) {
  return (
    <EntityDrawer
      description={`${accountKindLabel(account.kind)} · ${account.email}`}
      size="lg"
      title={account.displayName}
      trigger={
        <Button className="min-h-11 w-full xl:min-h-9 xl:w-auto" variant="outline">
          查看 {account.displayName}
        </Button>
      }
    >
      <ManagedAccountDrawerContent account={account} />
    </EntityDrawer>
  );
}

function AccountIdentity({ account }: { account: ManagedAccountSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="font-medium text-foreground">{account.displayName}</p>
      {account.kind === "SUPER_ADMIN" ? (
        <Badge className="gap-1 bg-primary-soft text-primary-hover" variant="secondary">
          <LockKeyhole aria-hidden="true" />
          受保护
        </Badge>
      ) : null}
    </div>
  );
}

function AccountEmail({ account }: { account: ManagedAccountSummary }) {
  return (
    <p className="min-w-0 whitespace-normal text-sm text-muted-foreground [overflow-wrap:anywhere]">
      {account.email}
    </p>
  );
}

function AccountRole({ account }: { account: ManagedAccountSummary }) {
  return <span className="text-sm text-foreground">{accountKindLabel(account.kind)}</span>;
}

function AccountCustomer({ account }: { account: ManagedAccountSummary }) {
  return <span className="text-sm text-foreground">{account.customerName ?? "—"}</span>;
}

function AccountStoreCount({ account }: { account: ManagedAccountSummary }) {
  return (
    <span className="text-sm tabular-nums text-foreground">
      {account.customerId ? `${account.storeCount} 家` : "—"}
    </span>
  );
}

function AccountStatus({ account }: { account: ManagedAccountSummary }) {
  return (
    <Badge className={accountStatusTone(account.status)} variant="secondary">
      {accountStatusLabel(account.status)}
    </Badge>
  );
}

function AccountLastLogin({ account }: { account: ManagedAccountSummary }) {
  return (
    <span className="text-sm text-muted-foreground">
      {formatAccountDateTime(account.lastLoginAt)}
    </span>
  );
}

function AccountTableRow({ account }: { account: ManagedAccountSummary }) {
  return (
    <TableRow>
      <TableCell className="min-w-0 whitespace-normal">
        <AccountIdentity account={account} />
      </TableCell>
      <TableCell
        className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
        data-account-email
      >
        <AccountEmail account={account} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <AccountRole account={account} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <AccountCustomer account={account} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <AccountStoreCount account={account} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <AccountStatus account={account} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <AccountLastLogin account={account} />
      </TableCell>
      <TableCell className="whitespace-normal text-right">
        <AccountDetailTrigger account={account} />
      </TableCell>
    </TableRow>
  );
}

function MobileAccountField({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AccountSummaryCard({ account }: { account: ManagedAccountSummary }) {
  return (
    <li
      className="rounded-[var(--radius-surface)] border border-border bg-background p-4 xl:hidden"
      data-account-card
    >
      <AccountIdentity account={account} />
      <div className="mt-1">
        <AccountEmail account={account} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3">
        <MobileAccountField label="角色">
          <AccountRole account={account} />
        </MobileAccountField>
        <MobileAccountField label="所属客户">
          <AccountCustomer account={account} />
        </MobileAccountField>
        <MobileAccountField label="店铺数">
          <AccountStoreCount account={account} />
        </MobileAccountField>
        <MobileAccountField label="状态">
          <AccountStatus account={account} />
        </MobileAccountField>
        <MobileAccountField label="最近登录">
          <AccountLastLogin account={account} />
        </MobileAccountField>
      </dl>
      <div className="mt-4 border-t border-border pt-3">
        <AccountDetailTrigger account={account} />
      </div>
    </li>
  );
}

function AccountSummaryList({ accounts }: { accounts: ManagedAccountSummary[] }) {
  return (
    <>
      <table
        aria-label="账号列表"
        className="hidden w-full table-fixed overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background text-sm xl:table"
        data-account-table
      >
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[18%]" />
          <col className="w-[10%]" />
          <col className="w-[13%]" />
          <col className="w-[7%]" />
          <col className="w-[8%]" />
          <col className="w-[18%]" />
          <col className="w-28" data-account-column="actions" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">姓名</TableHead>
            <TableHead scope="col">邮箱</TableHead>
            <TableHead scope="col">角色</TableHead>
            <TableHead scope="col">所属客户</TableHead>
            <TableHead scope="col">店铺数</TableHead>
            <TableHead scope="col">状态</TableHead>
            <TableHead scope="col">最近登录</TableHead>
            <TableHead className="text-right" scope="col">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => (
            <AccountTableRow account={account} key={account.userId} />
          ))}
        </TableBody>
      </table>
      <ul aria-label="账号摘要卡片" className="space-y-3 xl:hidden">
        {accounts.map((account) => (
          <AccountSummaryCard account={account} key={account.userId} />
        ))}
      </ul>
    </>
  );
}

export function AccountManagementWorkspace({
  accounts,
  focusedCustomerId,
}: {
  accounts: ManagedAccountSummary[];
  focusedCustomerId?: string;
}) {
  const [tab, setTab] = useState<AccountTab>(focusedCustomerId ? "customers" : "admins");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("ALL");
  const [status, setStatus] = useState<StatusFilter>("ALL");

  const scopedAccounts = useMemo(
    () =>
      focusedCustomerId
        ? accounts.filter((account) => account.customerId === focusedCustomerId)
        : accounts,
    [accounts, focusedCustomerId],
  );
  const focusedCustomerName = focusedCustomerId
    ? scopedAccounts.find((account) => account.customerName)?.customerName ?? null
    : null;
  const focusedFilterLabel = focusedCustomerName ? `客户：${focusedCustomerName}` : "指定客户";

  const counts = useMemo(
    () => ({
      admins: scopedAccounts.filter((account) => account.kind !== "CUSTOMER").length,
      customers: scopedAccounts.filter((account) => account.kind === "CUSTOMER").length,
      disabled: scopedAccounts.filter((account) => account.status === "DISABLED").length,
    }),
    [scopedAccounts],
  );

  function filteredAccounts(selectedTab: AccountTab) {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return scopedAccounts.filter((account) => {
      const matchesTab =
        selectedTab === "admins"
          ? account.kind !== "CUSTOMER"
          : selectedTab === "customers"
            ? account.kind === "CUSTOMER"
            : account.status === "DISABLED";
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [account.displayName, account.email, account.customerName]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
      return (
        matchesTab &&
        matchesQuery &&
        (role === "ALL" || account.kind === role) &&
        (status === "ALL" || account.status === status)
      );
    });
  }

  function clearFilters() {
    setQuery("");
    setRole("ALL");
    setStatus("ALL");
    setTab("admins");
  }

  return (
    <div className="space-y-6">
      <PageHeading
        action={
          <EntityDrawer
            description="只允许创建普通管理员；创建原因会保留在审计日志中。"
            title="新建管理员"
            trigger={
              <Button className="min-h-11">
                <Plus aria-hidden="true" />
                新建管理员
              </Button>
            }
          >
            <CreateAdminForm />
          </EntityDrawer>
        }
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "账号管理" }]}
        description="集中维护登录身份与访问状态。客户业务资料仍在客户详情中管理。"
        title="账号管理"
      />

      <Tabs onValueChange={(value) => setTab(value as AccountTab)} value={tab}>
        <TabsList className="min-h-11 w-full justify-start" variant="line">
          {tabs.map((item) => (
            <TabsTrigger className="min-h-11 flex-none px-3 sm:min-h-9" key={item.value} value={item.value}>
              {item.label} <span className="tabular-nums">{counts[item.value]}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <section aria-label="账号筛选" className="grid gap-3 border-y border-border py-4 sm:grid-cols-[minmax(16rem,1fr)_11rem_11rem]">
          <label className="relative block">
            <span className="sr-only">搜索账号</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="min-h-11 pl-10"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索姓名、邮箱或客户"
              type="search"
              value={query}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span className="sr-only">角色筛选</span>
            <select
              aria-label="角色筛选"
              className="min-h-11 w-full rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
              onChange={(event) => setRole(event.target.value as RoleFilter)}
              value={role}
            >
              <option value="ALL">全部角色</option>
              <option value="SUPER_ADMIN">超级管理员</option>
              <option value="ADMIN">普通管理员</option>
              <option value="CUSTOMER">客户账号</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span className="sr-only">状态筛选</span>
            <select
              aria-label="状态筛选"
              className="min-h-11 w-full rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
              value={status}
            >
              <option value="ALL">全部状态</option>
              <option value="ACTIVE">启用中</option>
              <option value="DISABLED">已停用</option>
            </select>
          </label>
        </section>

        {focusedCustomerId ? (
          <div aria-label="已启用筛选" className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">已启用</span>
            <Link
              aria-label={
                focusedCustomerName
                  ? `移除筛选：客户 ${focusedCustomerName}`
                  : "移除筛选：指定客户"
              }
              className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-background px-3 text-sm text-foreground transition-colors hover:bg-[var(--merchant-nav-hover)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/22"
              href="/admin/accounts"
            >
              <span>{focusedFilterLabel}</span>
              <X aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
        ) : null}

        {tabs.map((item) => {
          const rows = filteredAccounts(item.value);
          return (
            <TabsContent key={item.value} value={item.value}>
              {rows.length > 0 ? (
                <AccountSummaryList accounts={rows} />
              ) : (
                <ActionableEmptyState
                  action={
                    focusedCustomerId ? (
                      <Button asChild className="min-h-11" variant="outline">
                        <Link href="/admin/accounts">清除筛选</Link>
                      </Button>
                    ) : accounts.length > 0 ? (
                      <Button className="min-h-11" onClick={clearFilters} variant="outline">
                        清除筛选
                      </Button>
                    ) : undefined
                  }
                  description={
                    focusedCustomerId || accounts.length > 0
                      ? "当前标签或筛选条件下没有结果，请调整条件后重试。"
                      : "创建管理员或客户后，账号会显示在这里。"
                  }
                  kind={focusedCustomerId || accounts.length > 0 ? "filtered" : "initial"}
                  title={focusedCustomerId || accounts.length > 0 ? "没有符合条件的账号" : "暂无账号"}
                />
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
