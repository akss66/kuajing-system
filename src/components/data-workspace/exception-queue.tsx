import { AlertTriangle, ArrowRight } from "lucide-react";
import Link from "next/link";

export function ExceptionQueue({ lowStockCount }: { lowStockCount: number }) {
  return (
    <section className="rounded-[var(--radius-surface)] border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="font-semibold text-ink">异常待办</h2>
          <p className="mt-1 text-sm text-muted">需要管理员优先关注的运营事项</p>
        </div>
        <span className="rounded-full bg-warning/10 px-2.5 py-1 text-xs font-semibold text-warning">{lowStockCount} 项</span>
      </div>
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
          <AlertTriangle aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">低库存 SKU</p>
          <p className="mt-0.5 text-xs text-muted">可售库存不足 10 件，需要确认是否补货</p>
        </div>
        <Link className="flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover" href="/admin/inventory">
          查看 <ArrowRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </section>
  );
}
