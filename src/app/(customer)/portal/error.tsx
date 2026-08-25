"use client";

import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function CustomerPortalError({ reset }: { reset: () => void }) {
  return (
    <section aria-labelledby="portal-error-title" className="mx-auto max-w-2xl rounded-[var(--portal-surface-radius)] border border-danger/25 bg-background px-5 py-8 sm:px-8">
      <span className="flex size-11 items-center justify-center rounded-full bg-danger/10 text-danger"><AlertTriangle aria-hidden="true" className="size-5" /></span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground" id="portal-error-title">页面暂时无法加载</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">可能是网络或服务暂时波动。你的订单、付款和库存记录没有因此改变，可以重试或返回客户首页。</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button className="min-h-12" onClick={reset} type="button"><RotateCcw aria-hidden="true" />重新加载</Button>
        <Button asChild className="min-h-12" variant="outline"><Link href="/portal"><ArrowLeft aria-hidden="true" />返回客户首页</Link></Button>
      </div>
    </section>
  );
}
