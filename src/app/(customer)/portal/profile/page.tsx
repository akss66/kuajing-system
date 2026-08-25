import {
  ArrowRight,
  BadgeAlert,
  BadgeCheck,
  Building2,
  CalendarDays,
  CircleOff,
  LockKeyhole,
  Mail,
  Store,
  WalletCards,
} from "lucide-react";
import Link from "next/link";

import { PageHeading } from "@/components/layout/page-heading";
import { Badge } from "@/components/ui/badge";
import { getCustomerSelfProfile } from "@/modules/customers/queries";
import { requireCustomer } from "@/modules/identity/guards";
import { getWalletPosition } from "@/modules/wallet/queries";

function money(fen: number) {
  return `¥${(fen / 100).toFixed(2)}`;
}

function formatJoinDate(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeZone: "America/Toronto",
  }).format(value);
}

export default async function CustomerProfilePage() {
  const principal = await requireCustomer();
  const [profile, wallet] = await Promise.all([
    getCustomerSelfProfile({
      customerId: principal.customerId,
      userId: principal.userId,
    }),
    getWalletPosition(principal.customerId),
  ]);
  const displayInitial = Array.from(profile.account.displayName.trim())[0] ?? "客";
  const accountState =
    profile.customer.status !== "ACTIVE"
      ? "CUSTOMER_DISABLED"
      : profile.account.emailVerified
        ? "READY"
        : "EMAIL_UNVERIFIED";
  const accountStateLabel =
    accountState === "READY"
      ? "账号正常"
      : accountState === "EMAIL_UNVERIFIED"
        ? "邮箱未验证"
        : "客户已停用";

  return (
    <div className="space-y-8" data-customer-profile>
      <PageHeading
        description="查看当前登录账号、所属客户与可操作店铺。"
        title="个人中心"
      />

      <section
        aria-labelledby="profile-identity-title"
        className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]"
      >
        <div className="flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:px-7 sm:py-7">
          <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-[var(--portal-focus-surface)] text-2xl font-bold text-white shadow-sm">
            {displayInitial}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="break-words text-xl font-bold tracking-tight text-foreground" id="profile-identity-title">
                {profile.customer.name}
              </h2>
              <Badge
                className={
                  accountState === "READY"
                    ? "border-0 bg-[var(--portal-ready-surface)] text-success"
                    : "border-0 bg-warning/10 text-warning"
                }
                variant="outline"
              >
                {accountState === "READY" ? (
                  <BadgeCheck aria-hidden="true" />
                ) : (
                  <BadgeAlert aria-hidden="true" />
                )}
                {accountStateLabel}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">客户编号 {profile.customer.code}</p>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              当前由 <span className="font-semibold text-foreground">{profile.account.displayName}</span> 登录，可查看并操作下方绑定店铺。
            </p>
          </div>
        </div>

        <div className="grid border-t border-slate-100 bg-[var(--portal-subtle-surface)] sm:grid-cols-3">
          <div className="flex min-w-0 items-start gap-3 px-5 py-4 sm:px-6">
            <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">登录邮箱</p>
              <p className="mt-1 break-all text-sm font-medium text-foreground">{profile.account.email}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-start gap-3 border-t border-slate-100 px-5 py-4 sm:border-l sm:border-t-0 sm:px-6">
            <Building2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">所属客户</p>
              <p className="mt-1 break-words text-sm font-medium text-foreground">{profile.customer.name}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-start gap-3 border-t border-slate-100 px-5 py-4 sm:border-l sm:border-t-0 sm:px-6">
            <CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">账号开通</p>
              <p className="mt-1 text-sm font-medium text-foreground">{formatJoinDate(profile.account.createdAt)}</p>
            </div>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="profile-wallet-title"
        className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]"
      >
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--portal-icon-surface)] text-primary">
              <WalletCards aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-foreground" id="profile-wallet-title">资金概览</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">下单可用余额和当前订单占用。</p>
            </div>
          </div>
          <Link
            className="portal-inline-action inline-flex min-h-11 items-center justify-center gap-2 text-sm font-semibold text-primary-hover"
            href="/portal/wallet"
          >
            查看资金明细
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
        <div className="grid border-t border-slate-100 sm:grid-cols-3">
          <div className="bg-primary-soft/45 px-5 py-5 sm:px-6">
            <p className="text-xs font-medium text-primary-hover">当前可用</p>
            <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-primary">{money(wallet.availableFen)}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">可直接用于新的拿货单</p>
          </div>
          <div className="border-t border-slate-100 px-5 py-5 sm:border-l sm:border-t-0 sm:px-6">
            <p className="text-xs font-medium text-muted-foreground">账面余额</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-foreground">{money(wallet.balanceFen)}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">包含正在占用的金额</p>
          </div>
          <div className="border-t border-slate-100 px-5 py-5 sm:border-l sm:border-t-0 sm:px-6">
            <p className="text-xs font-medium text-muted-foreground">订单占用</p>
            <p className="mt-1 text-lg font-bold tabular-nums text-foreground">{money(wallet.activeHoldFen)}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">付款完成或订单关闭后更新</p>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <section aria-labelledby="profile-stores-title" className="space-y-3">
          <div className="flex items-end justify-between gap-4 px-1">
            <div>
              <h2 className="text-base font-bold text-foreground" id="profile-stores-title">绑定店铺</h2>
              <p className="mt-1 text-sm text-muted-foreground">上传订单时只能选择这些店铺。</p>
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums text-primary">{profile.stores.length} 家店铺</span>
          </div>

          <div className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]">
            {profile.stores.length ? (
              <ul className="divide-y divide-slate-100" role="list">
                {profile.stores.map((store) => {
                  const enabled = store.status === "ACTIVE";
                  return (
                    <li className="flex min-w-0 items-center gap-4 px-5 py-4 sm:px-6" key={store.id}>
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--portal-icon-surface)] text-primary">
                        <Store aria-hidden="true" className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-semibold text-foreground">{store.name}</p>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {store.platform}
                          {store.externalStoreCode ? ` · ${store.externalStoreCode}` : " · 暂无外部店铺编号"}
                        </p>
                      </div>
                      <Badge
                        className={enabled ? "border-0 bg-[var(--portal-ready-surface)] text-success" : "border-0 bg-slate-100 text-slate-600"}
                        variant="outline"
                      >
                        {enabled ? <BadgeCheck aria-hidden="true" /> : <CircleOff aria-hidden="true" />}
                        {enabled ? "可使用" : "已停用"}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="px-5 py-10 text-center sm:px-7">
                <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
                  <Store aria-hidden="true" className="size-5" />
                </span>
                <h3 className="mt-4 text-sm font-semibold text-foreground">暂未绑定店铺</h3>
                <p className="mt-1 text-sm text-muted-foreground">请联系同舟行管理员完成店铺绑定。</p>
              </div>
            )}
          </div>
        </section>

        <section
          aria-labelledby="profile-security-title"
          className="rounded-2xl bg-[var(--portal-focus-surface)] px-5 py-5 text-[var(--portal-focus-foreground)] shadow-[0_2px_12px_rgb(0_0_0/0.03)] sm:px-6 sm:py-6"
        >
          <span className="flex size-11 items-center justify-center rounded-xl bg-white/10 text-white">
            <LockKeyhole aria-hidden="true" className="size-5" />
          </span>
          <h2 className="mt-5 text-base font-bold text-white" id="profile-security-title">账号安全</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--portal-focus-muted)]">
            当前使用邮箱和密码登录。系统不会在个人中心展示或保存可读取的密码。
          </p>
          <div className="mt-5 rounded-xl bg-black/10 px-4 py-3 text-sm leading-6 text-[var(--portal-focus-foreground)]">
            如需修改登录邮箱、姓名或密码，请联系同舟行管理员核验身份后处理。
          </div>
        </section>
      </div>
    </div>
  );
}
