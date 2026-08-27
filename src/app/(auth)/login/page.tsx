import type { Metadata } from "next";
import Image from "next/image";

import { LoginForm } from "@/components/auth/login-form";
import { BRAND } from "@/shared/brand";

export const metadata: Metadata = { title: "登录" };

export default function LoginPage() {
  return (
    <main
      className="flex min-h-svh flex-col justify-center bg-login-canvas lg:grid lg:grid-cols-[minmax(0,1.12fr)_minmax(28rem,0.88fr)] lg:justify-normal"
      data-login-shell
    >
      <section
        className="login-metal-surface relative flex shrink-0 flex-col overflow-hidden bg-login-canvas px-6 pb-4 pt-6 sm:px-10 sm:pb-5 sm:pt-8 lg:min-h-svh lg:px-12 lg:py-10 xl:px-16 2xl:px-20"
        data-login-hero
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden text-login-hero-muted">
          <svg aria-hidden="true" className="absolute inset-x-0 bottom-10 hidden h-[72%] w-full opacity-[0.13] lg:block" data-login-route-graphic viewBox="0 0 920 640">
            <path d="M-20 562C120 512 168 391 298 354C430 316 468 405 604 306C706 232 750 129 954 90" fill="none" stroke="currentColor" strokeWidth="1.25" />
            <path d="M74 640C196 550 256 474 388 465C546 454 621 529 760 424C835 368 877 286 950 262" fill="none" stroke="currentColor" strokeWidth="0.8" />
            <path d="M298 354L388 465M604 306L760 424" fill="none" stroke="currentColor" strokeDasharray="5 9" strokeWidth="0.8" />
            <circle cx="298" cy="354" fill="currentColor" r="5" />
            <circle cx="388" cy="465" fill="currentColor" r="4" />
            <circle cx="604" cy="306" fill="currentColor" r="5" />
            <circle cx="760" cy="424" fill="none" r="15" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="954" cy="90" fill="none" r="24" stroke="currentColor" strokeWidth="1" />
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
          <div className="max-w-[46rem] -translate-y-4">
            <h2 className="text-balance text-[3.65rem] font-semibold leading-[1.04] tracking-[-0.04em] text-login-hero-foreground xl:text-[4.35rem] 2xl:text-[4.8rem]">
              <span className="block">加拿大本地货盘，</span>
              <span className="block">一站式经营更简单。</span>
            </h2>
            <p className="mt-8 max-w-[41rem] border-l border-white/20 pl-5 text-[16px] leading-8 text-login-hero-muted xl:text-[17px]">
              一键上传订单、跟进付款与发货状态，让每一次发货都清晰、可追踪、可恢复。
            </p>

          </div>
        </div>

        <p className="relative hidden shrink-0 text-xs text-login-hero-muted lg:block">业务时区 · 加拿大渥太华</p>
      </section>

      <section className="relative flex min-h-0 flex-1 flex-col items-center border-border/70 bg-white px-6 sm:px-10 lg:min-h-svh lg:border-l lg:px-14 xl:px-16">
        <div className="flex w-full flex-1 items-center justify-center py-10 sm:py-14 lg:py-16">
          <div className="w-full max-w-[27rem]" data-login-panel>
            <div className="mb-10">
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
