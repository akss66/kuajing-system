import type { Metadata } from "next";
import Image from "next/image";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BRAND } from "@/shared/brand";

export const metadata: Metadata = {
  title: "登录",
};

const inputClassName =
  "min-h-11 w-full rounded-[var(--radius-control)] border border-border bg-background px-3.5 text-[15px] text-ink shadow-[0_1px_1px_oklch(0.22_0.018_175/0.03)] transition-[border-color,box-shadow] duration-[var(--duration-fast)] placeholder:text-muted/75 hover:border-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15";

export default function LoginPage() {
  return (
    <main className="grid min-h-svh bg-surface lg:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)]">
      <section className="relative hidden overflow-hidden border-r border-border bg-[#f1f7f5] px-12 py-10 lg:flex lg:flex-col lg:justify-between xl:px-16">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-70">
          <div className="absolute -left-20 top-24 h-72 w-72 rounded-full border border-primary/10" />
          <div className="absolute -left-4 top-40 h-72 w-72 rounded-full border border-primary/10" />
          <div className="absolute bottom-[-16%] right-[-7%] h-[28rem] w-[28rem] rounded-full bg-primary/5" />
        </div>

        <div className="relative flex items-center gap-3">
          <Image
            src={BRAND.logoPath}
            alt=""
            width={42}
            height={40}
            className="h-10 w-auto object-contain"
            priority
          />
          <span className="text-lg font-semibold tracking-tight text-ink">{BRAND.name}</span>
        </div>

        <div className="relative max-w-xl pb-10">
          <p className="mb-4 text-sm font-semibold tracking-[0.14em] text-primary">跨境履约运营平台</p>
          <h2 className="text-balance text-[clamp(2.25rem,4vw,4.5rem)] font-semibold leading-[1.06] tracking-[-0.045em] text-ink">
            库存、订单与履约，
            <br />
            始终清楚可追溯。
          </h2>
          <p className="mt-7 max-w-lg text-base leading-7 text-muted">
            连接 TEMU 店铺、同舟行货盘与加拿大仓履约，让每一笔拿货、付款和发货都有准确记录。
          </p>
        </div>

        <p className="relative text-xs text-muted">业务时区 · 加拿大渥太华</p>
      </section>

      <section className="flex min-h-svh items-center justify-center bg-background px-5 py-10 sm:px-10 lg:px-14">
        <div className="w-full max-w-[420px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <Image
              src={BRAND.logoPath}
              alt={BRAND.name}
              width={40}
              height={38}
              className="h-9 w-auto object-contain"
              priority
            />
            <span className="font-semibold tracking-tight text-ink">{BRAND.name}</span>
          </div>

          <div className="mb-8">
            <p className="mb-2 text-sm font-medium text-primary">欢迎回来</p>
            <h1 className="text-3xl font-semibold tracking-[-0.035em] text-ink">登录同舟行跨境</h1>
            <p className="mt-3 text-sm leading-6 text-muted">使用管理员为你开通的账号进入系统。</p>
          </div>

          <form className="space-y-5" method="post">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-ink" htmlFor="email">
                登录邮箱
              </label>
              <Input
                autoComplete="email"
                className={inputClassName}
                id="email"
                name="email"
                placeholder="name@example.com"
                required
                type="email"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-ink" htmlFor="password">
                登录密码
              </label>
              <Input
                autoComplete="current-password"
                className={inputClassName}
                id="password"
                minLength={12}
                name="password"
                placeholder="请输入密码"
                required
                type="password"
              />
            </div>

            <Button
              className="mt-1 flex min-h-11 w-full items-center justify-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-semibold text-white shadow-[0_1px_2px_oklch(0.22_0.018_175/0.12)] transition-[background-color,transform] duration-[var(--duration-fast)] hover:bg-primary-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
            >
              登录系统
            </Button>
          </form>

          <div className="mt-8 border-t border-border pt-5 text-sm leading-6 text-muted">
            暂无账号或忘记密码？请通过微信联系同舟行管理员处理。
          </div>
        </div>
      </section>
    </main>
  );
}
