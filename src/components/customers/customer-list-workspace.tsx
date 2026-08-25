"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHeading } from "@/components/layout/page-heading";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CustomerManagementListRow } from "@/modules/customers/queries";

import { CreateCustomerDrawer } from "./create-customer-drawer";
import { CustomerListResults } from "./customer-list-results";

type CustomerStatusFilter = "ALL" | CustomerManagementListRow["status"];
type StoreCountFilter = "ALL" | "NONE" | "ONE" | "MULTIPLE";
type AccountStatusFilter = "ALL" | "ACTIVE" | "DISABLED" | "MISSING";
type ExceptionFilter = "ALL" | "WITH" | "WITHOUT";

export function CustomerListWorkspace({
  canCreateCustomers = true,
  rows,
}: {
  canCreateCustomers?: boolean;
  rows: CustomerManagementListRow[];
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CustomerStatusFilter>("ALL");
  const [storeCount, setStoreCount] = useState<StoreCountFilter>("ALL");
  const [accountStatus, setAccountStatus] = useState<AccountStatusFilter>("ALL");
  const [exceptions, setExceptions] = useState<ExceptionFilter>("ALL");

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return rows.filter((row) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [row.name, row.code, row.contactName, row.accountDisplayName, row.accountEmail]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
      const matchesStatus = status === "ALL" || row.status === status;
      const matchesStoreCount =
        storeCount === "ALL" ||
        (storeCount === "NONE" && row.storeCount === 0) ||
        (storeCount === "ONE" && row.storeCount === 1) ||
        (storeCount === "MULTIPLE" && row.storeCount >= 2);
      const matchesAccount =
        accountStatus === "ALL" ||
        (accountStatus === "MISSING" && row.accountStatus === null) ||
        row.accountStatus === accountStatus;
      const matchesExceptions =
        exceptions === "ALL" ||
        (exceptions === "WITH" && row.exceptionOrderCount > 0) ||
        (exceptions === "WITHOUT" && row.exceptionOrderCount === 0);
      return matchesQuery && matchesStatus && matchesStoreCount && matchesAccount && matchesExceptions;
    });
  }, [accountStatus, exceptions, query, rows, status, storeCount]);

  const advancedFilterCount = Number(accountStatus !== "ALL") + Number(exceptions !== "ALL");

  function clearFilters() {
    setQuery("");
    setStatus("ALL");
    setStoreCount("ALL");
    setAccountStatus("ALL");
    setExceptions("ALL");
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        action={canCreateCustomers ? <CreateCustomerDrawer /> : undefined}
        breadcrumbs={[{ href: "/admin", label: "管理工作台" }, { label: "客户与店铺" }]}
        description="集中查看客户账号、店铺覆盖、账户余额与近期履约风险。"
        title="客户与店铺"
      />

      {rows.length === 0 ? (
        <ActionableEmptyState
          action={canCreateCustomers ? <CreateCustomerDrawer first /> : undefined}
          description={
            canCreateCustomers
              ? "先创建客户、唯一登录账号与首家店铺，之后即可在这里跟踪资金和订单。"
              : "当前账号无权创建客户，请联系管理员。"
          }
          kind="initial"
          title="暂无客户"
        />
      ) : (
        <section aria-label="客户管理工作区" className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-3 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_11rem_11rem_auto]">
            <label className="relative min-w-0">
              <span className="sr-only">搜索客户</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="搜索客户"
                className="min-h-11 pl-10"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索客户、编号、账号或联系人"
                type="search"
                value={query}
              />
            </label>
            <select
              aria-label="客户状态筛选"
              className="min-h-11 min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
              onChange={(event) => setStatus(event.target.value as CustomerStatusFilter)}
              value={status}
            >
              <option value="ALL">全部客户状态</option>
              <option value="ACTIVE">启用中</option>
              <option value="DISABLED">已停用</option>
            </select>
            <select
              aria-label="店铺数筛选"
              className="min-h-11 min-w-0 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
              onChange={(event) => setStoreCount(event.target.value as StoreCountFilter)}
              value={storeCount}
            >
              <option value="ALL">全部店铺数</option>
              <option value="NONE">暂无店铺</option>
              <option value="ONE">1 家店铺</option>
              <option value="MULTIPLE">2 家及以上</option>
            </select>
            <EntityDrawer
              description="补充按账号同步状态与订单异常筛选。"
              title="更多筛选"
              trigger={
                <Button className="min-h-11 w-full xl:w-auto" variant="outline">
                  <SlidersHorizontal aria-hidden="true" />
                  更多筛选{advancedFilterCount > 0 ? ` ${advancedFilterCount}` : ""}
                </Button>
              }
            >
              <DrawerSection title="账号与履约">
                <div className="grid gap-4">
                  <label className="grid gap-2 text-sm font-medium text-foreground">
                    账号状态
                    <select
                      className="min-h-11 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
                      onChange={(event) => setAccountStatus(event.target.value as AccountStatusFilter)}
                      value={accountStatus}
                    >
                      <option value="ALL">全部账号状态</option>
                      <option value="ACTIVE">账号正常</option>
                      <option value="DISABLED">账号已停用</option>
                      <option value="MISSING">账号待同步</option>
                    </select>
                  </label>
                  <label className="grid gap-2 text-sm font-medium text-foreground">
                    异常订单
                    <select
                      className="min-h-11 rounded-[var(--radius-control)] border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/18"
                      onChange={(event) => setExceptions(event.target.value as ExceptionFilter)}
                      value={exceptions}
                    >
                      <option value="ALL">全部异常状态</option>
                      <option value="WITH">存在异常</option>
                      <option value="WITHOUT">无异常</option>
                    </select>
                  </label>
                  <Button className="min-h-11" onClick={clearFilters} type="button" variant="outline">
                    清除筛选
                  </Button>
                </div>
              </DrawerSection>
            </EntityDrawer>
          </div>

          {filteredRows.length > 0 ? (
            <CustomerListResults rows={filteredRows} />
          ) : (
            <ActionableEmptyState
              action={
                <Button className="min-h-11" onClick={clearFilters} type="button" variant="outline">
                  清除筛选
                </Button>
              }
              description="当前搜索或筛选条件下没有结果，请清除条件后重试。"
              kind="filtered"
              title="没有符合条件的客户"
            />
          )}
        </section>
      )}
    </div>
  );
}
