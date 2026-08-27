import { Sparkles } from "lucide-react";

import { ThreeUiAmbientScene } from "@/components/branding/threeui-ambient-scene";

export function CustomerPortalBrandAccent() {
  return (
    <section
      className="relative overflow-hidden rounded-[1.35rem] border border-[var(--portal-border-strong)] bg-white/88 px-4 py-4 shadow-[0_10px_32px_rgb(15_23_42/0.05)] sm:min-w-[21rem] sm:px-5"
      data-portal-brand-accent
    >
      <ThreeUiAmbientScene scene="portal" />
      <div className="relative flex min-h-[6.5rem] items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/78 px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-primary shadow-sm ring-1 ring-[var(--portal-border-strong)]">
            <Sparkles aria-hidden="true" className="size-3" />
            CLIENT FLOW
          </span>
          <p className="mt-3 text-sm font-semibold tracking-[-0.02em] text-foreground">
            货盘、上传、订单与资金回到同一条工作线。
          </p>
          <p className="mt-1.5 max-w-[18rem] text-xs leading-5 text-muted-foreground">
            先确认可售库存，再继续上传与跟进付款发货。
          </p>
        </div>
        <div className="relative hidden h-[6.5rem] w-[7.5rem] shrink-0 self-end overflow-hidden rounded-2xl border border-white/70 bg-[rgb(245_248_246/0.92)] sm:block">
          <ThreeUiAmbientScene className="opacity-[0.95]" scene="portal" />
        </div>
      </div>
    </section>
  );
}
