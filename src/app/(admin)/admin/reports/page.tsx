import { AlertTriangle, Banknote, Boxes, PackageCheck, Store } from "lucide-react";

import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseTorontoDateRange, ReportRangeError } from "@/modules/reports/date-range";
import { getOperationsReport } from "@/modules/reports/query";

function money(fen: number) {
  return new Intl.NumberFormat("zh-CN", { currency: "CNY", style: "currency" }).format(fen / 100);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const filters = await searchParams;
  let error: string | null = null;
  let range;
  try {
    range = parseTorontoDateRange({ from: filters.from, to: filters.to });
  } catch (caught) {
    error = caught instanceof ReportRangeError ? caught.message : "无法解析报表日期";
    range = parseTorontoDateRange({});
  }
  const report = await getOperationsReport(range);
  const cards = [
    { icon: PackageCheck, label: "已发货订单", value: report.summary.orderCount.toLocaleString("zh-CN") },
    { icon: Boxes, label: "普通出库件数", value: report.summary.quantity.toLocaleString("zh-CN") },
    { icon: Banknote, label: "实际销售额", value: money(report.summary.revenueFen) },
    { icon: AlertTriangle, label: "补发件数", value: report.summary.replacementQuantity.toLocaleString("zh-CN") },
  ];

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-primary">多伦多自然日口径</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">经营报表</h1>
        <p className="mt-2 text-sm text-muted">普通包裹在极风确认已发货后计入销量；补发单独统计且不重复计算销售额。</p>
      </header>

      <form className="grid gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" method="get">
        <label className="space-y-2 text-sm font-medium text-ink">开始日期<input className="min-h-11 w-full rounded-lg border border-border bg-background px-3" defaultValue={range.fromDate} name="from" required type="date" /></label>
        <label className="space-y-2 text-sm font-medium text-ink">结束日期<input className="min-h-11 w-full rounded-lg border border-border bg-background px-3" defaultValue={range.toDate} name="to" required type="date" /></label>
        <button className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover" type="submit">生成报表</button>
        {error ? <p className="text-sm text-danger sm:col-span-3" role="alert">{error}，已显示最近 7 天。</p> : null}
      </form>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="报表概览">
        {cards.map((card) => <article className="rounded-[var(--radius-surface)] border border-border bg-background p-5" key={card.label}><card.icon aria-hidden="true" className="size-5 text-primary" /><p className="mt-4 text-2xl font-semibold tabular-nums text-ink">{card.value}</p><p className="mt-1 text-sm text-muted">{card.label}</p></article>)}
      </section>

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="border-b border-border px-4 py-4 sm:px-5"><h2 className="font-semibold text-ink">SKU 出库排名</h2><p className="mt-1 text-sm text-muted">按普通包裹实际出库数量排序，收入使用订单保存的实际成交价。</p></div>
        <ResponsiveDataTable><Table><TableHeader><TableRow><TableHead>排名</TableHead><TableHead>SKU</TableHead><TableHead>名称</TableHead><TableHead className="text-right">出库件数</TableHead><TableHead className="text-right">销售额</TableHead></TableRow></TableHeader><TableBody>{report.skuSales.length ? report.skuSales.map((row, index) => <TableRow key={row.skuId}><TableCell className="tabular-nums">{index + 1}</TableCell><TableCell className="font-semibold">{row.skuCode}</TableCell><TableCell>{row.skuName}</TableCell><TableCell className="text-right tabular-nums">{row.quantity}</TableCell><TableCell className="text-right tabular-nums">{money(row.revenueFen)}</TableCell></TableRow>) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={5}>所选日期内暂无普通包裹出库。</TableCell></TableRow>}</TableBody></Table></ResponsiveDataTable>
      </section>

      <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background">
        <div className="border-b border-border px-4 py-4 sm:px-5"><h2 className="flex items-center gap-2 font-semibold text-ink"><Store aria-hidden="true" className="size-4 text-primary" />店铺销量</h2></div>
        <ResponsiveDataTable><Table><TableHeader><TableRow><TableHead>店铺</TableHead><TableHead className="text-right">订单</TableHead><TableHead className="text-right">包裹</TableHead><TableHead className="text-right">件数</TableHead><TableHead className="text-right">销售额</TableHead></TableRow></TableHeader><TableBody>{report.stores.length ? report.stores.map((row) => <TableRow key={row.storeId}><TableCell className="font-medium">{row.storeName}</TableCell><TableCell className="text-right tabular-nums">{row.orderCount}</TableCell><TableCell className="text-right tabular-nums">{row.packageCount}</TableCell><TableCell className="text-right tabular-nums">{row.quantity}</TableCell><TableCell className="text-right tabular-nums">{money(row.revenueFen)}</TableCell></TableRow>) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={5}>所选日期内暂无店铺出库。</TableCell></TableRow>}</TableBody></Table></ResponsiveDataTable>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="overflow-hidden rounded-[var(--radius-surface)] border border-border bg-background"><div className="border-b border-border px-4 py-4 sm:px-5"><h2 className="font-semibold text-ink">补发分析</h2><p className="mt-1 text-sm text-muted">仅统计已发货补发，不计销售收入。</p></div><ResponsiveDataTable><Table><TableHeader><TableRow><TableHead>原因</TableHead><TableHead className="text-right">补发单</TableHead><TableHead className="text-right">件数</TableHead></TableRow></TableHeader><TableBody>{report.replacements.length ? report.replacements.map((row) => <TableRow key={row.reason}><TableCell className="whitespace-normal">{row.reason}</TableCell><TableCell className="text-right tabular-nums">{row.requestCount}</TableCell><TableCell className="text-right tabular-nums">{row.quantity}</TableCell></TableRow>) : <TableRow><TableCell className="h-28 text-center text-muted" colSpan={3}>所选日期内暂无已发货补发。</TableCell></TableRow>}</TableBody></Table></ResponsiveDataTable></section>
        <section className="rounded-[var(--radius-surface)] border border-border bg-background"><div className="border-b border-border px-4 py-4 sm:px-5"><h2 className="font-semibold text-ink">人民币资金</h2><p className="mt-1 text-sm text-muted">物流费为加拿大元，不混入本表。</p></div><dl className="divide-y divide-border px-4 sm:px-5">{[
          ["余额充值", report.funds.adminCreditsFen], ["余额人工扣减", report.funds.adminDebitsFen], ["余额订单消费", report.funds.orderDebitsFen], ["订单退款", report.funds.orderRefundsFen], ["已确认线下付款", report.funds.approvedOfflineFen], ["待收款", report.funds.pendingReceivableFen],
        ].map(([label, value]) => <div className="flex min-h-12 items-center justify-between gap-4" key={String(label)}><dt className="text-sm text-muted">{label}</dt><dd className="font-semibold tabular-nums text-ink">{money(Number(value))}</dd></div>)}</dl><div className="px-4 pb-4 sm:px-5"><Badge className="bg-primary-soft text-primary-hover" variant="secondary">全部金额均为人民币</Badge></div></section>
      </div>
    </div>
  );
}
