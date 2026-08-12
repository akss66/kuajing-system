import type { Metadata } from "next";
import Image from "next/image";

import { LoginForm } from "@/components/auth/login-form";
import { BRAND } from "@/shared/brand";

export const metadata: Metadata = { title: "登录" };

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
          <Image alt="" className="h-10 w-auto object-contain" height={40} priority src={BRAND.logoPath} width={42} />
          <span className="text-lg font-semibold tracking-tight text-ink">{BRAND.name}</span>
        </div>

        <div className="relative max-w-xl pb-10">
          <p className="mb-4 text-sm font-semibold tracking-[0.14em] text-primary">跨境拿货运营平台</p>
          <h2 className="text-balance text-[clamp(2.25rem,4vw,4.5rem)] font-semibold leading-[1.06] tracking-[-0.045em] text-ink">
            库存、订单与发货，
            <br />
            始终清晰可追踪。
          </h2>
          <p className="mt-7 max-w-lg text-base leading-7 text-muted">
            连接 TEMU 店铺、同舟行货盘与加拿大仓发货流程，让每一笔拿货、付款和出库都有准确记录。
          </p>
        </div>

        <p className="relative text-xs text-muted">业务时区 · 加拿大渥太华</p>
      </section>

      <section className="flex min-h-svh items-center justify-center bg-background px-5 py-10 sm:px-10 lg:px-14">
        <div className="w-full max-w-[420px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <Image alt={BRAND.name} className="h-9 w-auto object-contain" height={38} priority src={BRAND.logoPath} width={40} />
            <span className="font-semibold tracking-tight text-ink">{BRAND.name}</span>
          </div>

          <div className="mb-8">
            <p className="mb-2 text-sm font-medium text-primary">欢迎回来</p>
            <h1 className="text-3xl font-semibold tracking-[-0.035em] text-ink">登录同舟行跨境</h1>
            <p className="mt-3 text-sm leading-6 text-muted">使用管理员为你开通的账号进入系统。</p>
          </div>

          <LoginForm />

          <div className="mt-8 border-t border-border pt-5 text-sm leading-6 text-muted">
            暂无账号或忘记密码？请通过微信联系同舟行管理员处理。
          </div>
        </div>
      </section>
    </main>
  );
}
