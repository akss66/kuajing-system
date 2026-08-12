import type { Metadata } from "next";
import Image from "next/image";

import { LoginForm } from "@/components/auth/login-form";
import { BRAND } from "@/shared/brand";

export const metadata: Metadata = { title: "登录" };

export default function LoginPage() {
  return (
    <main className="grid min-h-svh bg-surface lg:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)]">
      <section className="relative hidden overflow-hidden border-r border-border bg-[linear-gradient(180deg,rgba(241,246,245,0.98),rgba(233,240,238,0.98))] px-12 py-10 lg:flex lg:flex-col lg:justify-between xl:px-16">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-70">
          <div className="absolute -left-18 top-20 h-64 w-64 rounded-full border border-primary/10" />
          <div className="absolute left-8 top-36 h-64 w-64 rounded-full border border-primary/8" />
          <div className="absolute bottom-[-18%] right-[-10%] h-[26rem] w-[26rem] rounded-full bg-primary/5" />
        </div>

        <div className="relative flex items-center gap-3">
          <Image alt="" className="h-10 w-auto object-contain" height={40} priority src={BRAND.logoPath} width={42} />
          <span className="text-lg font-semibold tracking-tight text-foreground">{BRAND.name}</span>
        </div>

        <div className="relative max-w-xl pb-10">
          <p className="mb-4 text-sm font-semibold tracking-[0.14em] text-primary">商家工作台</p>
          <h2 className="text-balance text-[clamp(2.2rem,4vw,4.4rem)] font-semibold leading-[1.05] tracking-[-0.045em] text-foreground">
            加拿大本地货盘，
            <br />
            选品拿货更简单。
          </h2>
          <p className="mt-7 max-w-lg text-base leading-7 text-muted-foreground">
            统一查看货盘、上传订单、跟进付款与发货状态，让每一笔拿货单都清楚、可追踪、可恢复。
          </p>
        </div>

        <p className="relative text-xs text-muted-foreground">业务时区 · 加拿大渥太华</p>
      </section>

      <section className="flex min-h-svh items-center justify-center bg-background px-5 py-10 sm:px-10 lg:px-14">
        <div className="w-full max-w-[420px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <Image alt={BRAND.name} className="h-9 w-auto object-contain" height={38} priority src={BRAND.logoPath} width={40} />
            <span className="font-semibold tracking-tight text-foreground">{BRAND.name}</span>
          </div>

          <div className="mb-8">
            <p className="mb-2 text-sm font-medium text-primary">欢迎回来</p>
            <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground">登录同舟行跨境</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">使用管理员为你开通的账号进入系统。</p>
          </div>

          <LoginForm />

          <div className="mt-8 border-t border-border pt-5 text-sm leading-6 text-muted-foreground">
            暂无账号或忘记密码？请通过微信联系同舟行管理员处理。
          </div>
        </div>
      </section>
    </main>
  );
}
