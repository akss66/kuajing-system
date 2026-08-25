import { LoaderCircle } from "lucide-react";

export default function CustomerPortalLoading() {
  return (
    <div aria-label="正在加载客户中心" className="space-y-5" role="status">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <span className="flex size-10 items-center justify-center rounded-[0.75rem] bg-primary-soft text-primary">
          <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
        </span>
        <div>
          <p className="font-semibold text-foreground">正在加载拿货信息</p>
          <p className="mt-1 text-sm text-muted-foreground">订单和资金数据不会因刷新而改变。</p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2" aria-hidden="true">
        <div className="h-48 animate-pulse rounded-[var(--portal-surface-radius)] bg-primary-soft/55" />
        <div className="h-48 animate-pulse rounded-[var(--portal-surface-radius)] bg-surface-muted" />
      </div>
    </div>
  );
}
