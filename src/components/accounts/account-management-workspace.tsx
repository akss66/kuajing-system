"use client";

import { LockKeyhole, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const desktopColumns =
  "lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(0,.8fr)_minmax(0,1fr)_minmax(0,.6fr)_minmax(0,.7fr)_minmax(0,1fr)_auto]";

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
        <Button className="min-h-11 w-full lg:min-h-9 lg:w-auto" variant="outline">
          查看 {account.displayName}
        </Button>
      }
    >
      <ManagedAccountDrawerContent account={account} />
    </EntityDrawer>
  );
}

function MobileFieldLabel({ children }: { children: string }) {
  return <span className="text-xs font-medium text-muted-foreground lg:hidden">{children}</span>;
}

function AccountSummaryList({ accounts }: { accounts: ManagedAccountSummary[] }) {
  return (
    <section aria-label="账号列表" className="space-y-3" role="table">
      <div
        className={`hidden min-h-10 items-center border-b border-border bg-[var(--merchant-table-header)] px-3 text-xs font-semibold text-muted-foreground lg:grid ${desktopColumns}`}
        data-account-table
        role="row"
      >
        <span role="columnheader">姓名</span>
        <span role="columnheader">邮箱</span>
        <span role="columnheader">角色</span>
        <span role="columnheader">所属客户</span>
        <span role="columnheader">店铺数</span>
        <span role="columnheader">状态</span>
        <span role="columnheader">最近登录</span>
        <span role="columnheader">操作</span>
      </div>
      <ul
        className="space-y-3 lg:space-y-0 lg:overflow-hidden lg:rounded-[var(--radius-surface)] lg:border lg:border-border lg:bg-background"
        data-account-list
        role="rowgroup"
      >
        {accounts.map((account) => (
          <li
            className={`grid gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4 lg:min-h-14 lg:items-center lg:gap-2 lg:rounded-none lg:border-x-0 lg:border-t-0 lg:px-3 lg:py-2 lg:last:border-b-0 ${desktopColumns}`}
            data-account-card
            key={account.userId}
            role="row"
          >
            <div className="min-w-0" role="cell">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-foreground">{account.displayName}</p>
                {account.kind === "SUPER_ADMIN" ? (
                  <Badge className="gap-1 bg-primary/10 text-primary" variant="secondary">
                    <LockKeyhole aria-hidden="true" />
                    受保护
                  </Badge>
                ) : null}
              </div>
            </div>
            <p className="min-w-0 break-all text-sm text-muted-foreground" role="cell">
              {account.email}
            </p>
            <div className="space-y-1" role="cell">
              <MobileFieldLabel>角色</MobileFieldLabel>
              <p className="text-sm text-foreground">{accountKindLabel(account.kind)}</p>
            </div>
            <div className="space-y-1" role="cell">
              <MobileFieldLabel>所属客户</MobileFieldLabel>
              <p className="text-sm text-foreground">{account.customerName ?? "—"}</p>
            </div>
            <div className="space-y-1" role="cell">
              <MobileFieldLabel>店铺数</MobileFieldLabel>
              <p className="text-sm tabular-nums text-foreground">
                {account.customerId ? `${account.storeCount} 家` : "—"}
              </p>
            </div>
            <div className="space-y-1" role="cell">
              <MobileFieldLabel>状态</MobileFieldLabel>
              <Badge className={accountStatusTone(account.status)} variant="secondary">
                {accountStatusLabel(account.status)}
              </Badge>
            </div>
            <div className="space-y-1" role="cell">
              <MobileFieldLabel>最近登录</MobileFieldLabel>
              <p className="text-sm text-muted-foreground">{formatAccountDateTime(account.lastLoginAt)}</p>
            </div>
            <div className="lg:justify-self-end" role="cell">
              <AccountDetailTrigger account={account} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AccountManagementWorkspace({ accounts }: { accounts: ManagedAccountSummary[] }) {
  const [tab, setTab] = useState<AccountTab>("admins");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("ALL");
  const [status, setStatus] = useState<StatusFilter>("ALL");

  const counts = useMemo(
    () => ({
      admins: accounts.filter((account) => account.kind !== "CUSTOMER").length,
      customers: accounts.filter((account) => account.kind === "CUSTOMER").length,
      disabled: accounts.filter((account) => account.status === "DISABLED").length,
    }),
    [accounts],
  );

  function filteredAccounts(selectedTab: AccountTab) {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return accounts.filter((account) => {
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
        <TabsList className="min-h-11 w-full justify-start overflow-x-auto" variant="line">
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

        {tabs.map((item) => {
          const rows = filteredAccounts(item.value);
          return (
            <TabsContent key={item.value} value={item.value}>
              {rows.length > 0 ? (
                <AccountSummaryList accounts={rows} />
              ) : (
                <ActionableEmptyState
                  action={
                    accounts.length > 0 ? (
                      <Button className="min-h-11" onClick={clearFilters} variant="outline">
                        清除筛选
                      </Button>
                    ) : undefined
                  }
                  description={
                    accounts.length > 0
                      ? "当前标签或筛选条件下没有结果，请调整条件后重试。"
                      : "创建管理员或客户后，账号会显示在这里。"
                  }
                  kind={accounts.length > 0 ? "filtered" : "initial"}
                  title={accounts.length > 0 ? "没有符合条件的账号" : "暂无账号"}
                />
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
