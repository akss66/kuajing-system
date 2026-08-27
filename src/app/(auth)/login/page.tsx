import type { Metadata } from "next";
import Image from "next/image";

import { LoginForm } from "@/components/auth/login-form";
import { BRAND } from "@/shared/brand";

export const metadata: Metadata = { title: "登录" };

export default function LoginPage() {
  return (
    <main
      className="flex min-h-svh flex-col justify-center bg-login-canvas lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(30rem,0.92fr)] lg:justify-normal"
      data-login-shell
    >
      <section
        className="login-metal-surface relative flex flex-col overflow-hidden bg-login-canvas px-6 pb-2 pt-6 sm:px-10 sm:pb-3 sm:pt-8 lg:min-h-svh lg:px-12 lg:py-10 xl:px-16"
        data-login-hero
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden text-login-hero-muted">
          <svg className="absolute -right-24 top-1/2 hidden h-[32rem] w-[44rem] -translate-y-1/2 opacity-[0.08] lg:block" viewBox="0 0 704 512">
            <path d="M34 390C150 316 203 164 346 143C474 124 524 252 670 96" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M86 458C213 400 296 276 410 268C530 258 583 344 706 224" fill="none" stroke="currentColor" strokeWidth="1" />
            <circle cx="346" cy="143" fill="currentColor" r="5" />
            <circle cx="410" cy="268" fill="currentColor" r="4" />
            <circle cx="670" cy="96" fill="none" r="18" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>

        <div className="relative flex shrink-0 items-center gap-3.5">
          <Image alt={BRAND.name} className="h-11 w-auto object-contain" height={44} priority src={BRAND.logoPath} width={46} />
          <div>
            <div className="text-lg font-semibold tracking-[-0.02em] text-foreground lg:text-login-hero-foreground">{BRAND.name}</div>
            <div className="mt-0.5 text-xs font-medium tracking-[0.04em] text-muted-foreground lg:text-login-hero-muted">AI+Agent+跨境</div>
          </div>
        </div>

        <div className="relative hidden lg:flex lg:flex-1 lg:items-center lg:py-16">
          <div className="max-w-[44rem]">
            <h2 className="text-balance text-[clamp(2.25rem,5.1vw,4.75rem)] font-semibold leading-[1.03] tracking-[-0.04em] text-login-hero-foreground">
              <span className="block">加拿大本地货盘，</span>
              <span className="block">一站式经营更简单。</span>
            </h2>
            <p className="mt-6 max-w-[43rem] text-[15px] leading-7 text-login-hero-muted sm:text-base lg:mt-8 lg:text-[17px] lg:leading-8">
              一键上传订单、跟进付款与发货状态，让每一次发货都清晰、可追踪、可恢复。
            </p>

          </div>
        </div>

        <p className="relative hidden shrink-0 text-xs text-login-hero-muted lg:block">业务时区 · 加拿大渥太华</p>
      </section>

      <section className="relative flex min-h-0 flex-1 flex-col items-center border-border/70 bg-login-canvas px-6 sm:px-10 lg:min-h-svh lg:border-l lg:px-14">
        <div className="flex w-full flex-1 items-center justify-center py-10 sm:py-14 lg:py-16">
          <div className="w-full max-w-[27rem]" data-login-panel>
            <div className="mb-9">
              <h1 className="text-[2rem] font-semibold tracking-[-0.035em] text-foreground">欢迎回来</h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">使用管理员为你开通的账号进入系统。</p>
            </div>

            <LoginForm />

            <div className="mt-8 border-t border-border pt-5 text-sm leading-6 text-muted-foreground">
              暂无账号或忘记密码？请微信联系同舟行管理员。
            </div>
          </div>
        </div>

        <p className="shrink-0 pb-6 text-center text-[11px] font-medium tracking-[0.08em] text-muted-foreground sm:pb-8">
          Designed &amp; Developed by ZZY
        </p>
      </section>
    </main>
  );
}
