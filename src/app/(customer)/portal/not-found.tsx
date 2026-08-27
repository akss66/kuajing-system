import { ArrowLeft, FileQuestion } from "lucide-react";
import Link from "next/link";

export default function CustomerPortalNotFound() {
  return (
    <section aria-labelledby="portal-not-found-title" className="mx-auto max-w-2xl rounded-[var(--portal-surface-radius)] border border-border bg-background px-5 py-8 sm:px-8">
      <span className="flex size-11 items-center justify-center rounded-full bg-primary-soft text-primary"><FileQuestion aria-hidden="true" className="size-5" /></span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground" id="portal-not-found-title">没有找到这条记录</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">记录可能已过期、地址不完整，或不属于当前客户。系统没有修改任何订单、资金或库存数据。</p>
      <Link className="portal-page-primary mt-6 inline-flex min-h-12 items-center gap-2 rounded-[0.7rem] bg-primary px-5 text-sm font-semibold text-white" href="/portal"><ArrowLeft aria-hidden="true" className="size-4" />返回经营概览</Link>
    </section>
  );
}
