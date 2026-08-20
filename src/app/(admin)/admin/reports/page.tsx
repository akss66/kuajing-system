import Link from "next/link";
import { BarChart3, Boxes, Store, Trophy } from "lucide-react";

import { ResponsiveDataTable } from "@/components/data-workspace/responsive-data-table";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel, WorkspacePanelHeader } from "@/components/layout/workspace-panel";
import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { OperationsReportTrend } from "@/components/reports/operations-report-trend";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseTorontoDateRange, ReportRangeError } from "@/modules/reports/date-range";
import { getOperationsReport } from "@/modules/reports/query";
import { getStockCoverageReport } from "@/modules/reports/stock-coverage";

function money(fen: number) {
  return new Intl.NumberFormat("zh-CN", {
    currency: "CNY",
    style: "currency",
  }).format(fen / 100);
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

  const [report, coverage] = await Promise.all([
    getOperationsReport(range),
    getStockCoverageReport(),
  ]);
  const coverageRisks = coverage.filter(
    (row) => row.alertLevel === "CRITICAL" || row.alertLevel === "WARNING",
  );
  const hasTrendData = report.trend.some(
    (point) => point.orderCount > 0 || point.revenueFen !== 0,
  );
  const hasReportData =
    report.skuSales.length > 0 ||
    report.stores.length > 0 ||
    report.replacements.length > 0 ||
    hasTrendData ||
    Object.values(report.funds).some((value) => value !== 0);

  return (
    <div className="space-y-6">
      <PageHeading
        breadcrumbs={[
          { href: "/admin", label: "管理工作台" },
          { label: "经营报表" },
        ]}
        description="普通包裹在仓储确认已发货后计入销量；补发单独统计，不重复计算销售额。"
        title="经营报表"
      />

      <section aria-labelledby="report-range-title" className="border-y border-border py-4">
        <h2 className="sr-only" id="report-range-title">报表日期范围</h2>
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" method="get">
          <label className="space-y-2 text-sm font-medium text-ink">
            开始日期
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3"
              defaultValue={range.fromDate}
              name="from"
              required
              type="date"
            />
          </label>
          <label className="space-y-2 text-sm font-medium text-ink">
            结束日期
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3"
              defaultValue={range.toDate}
              name="to"
              required
              type="date"
            />
          </label>
          <button
            className="min-h-11 rounded-lg bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover"
            type="submit"
          >
            生成报表
          </button>
          {error ? (
            <p className="text-sm text-danger sm:col-span-3" role="alert">
              {error}，已显示最近 7 天。
            </p>
          ) : null}
        </form>
      </section>

      {!hasReportData ? (
        <ActionableEmptyState
          action={<Link className="text-sm font-semibold text-primary hover:text-primary-hover" href="/admin/reports">查看最近 7 天</Link>}
          description="该时间段没有已发货普通包裹或补发记录。可调整日期，或返回默认区间继续查看。"
          kind="filtered"
          title="所选区间暂无经营数据"
        />
      ) : null}

      <section aria-labelledby="report-trend-title" className="border-b border-border pb-6">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground" id="report-trend-title">
              <BarChart3 aria-hidden="true" className="size-4 text-primary" />近 7 天经营趋势
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">按实际发货日观察涉及拿货单与商品销售额变化；同一拿货单跨日发货时会出现在多个日期，不含每包 13 元物流费。</p>
          </div>
          <dl className="hidden gap-5 text-right sm:flex">
            <div><dt className="text-xs text-muted-foreground">已发货订单</dt><dd className="mt-1 font-semibold tabular-nums">{report.summary.orderCount}</dd></div>
            <div><dt className="text-xs text-muted-foreground">商品销售额（不含物流费）</dt><dd className="mt-1 font-semibold tabular-nums">{money(report.summary.revenueFen)}</dd></div>
          </dl>
        </div>
        {hasTrendData ? <OperationsReportTrend series={report.trend} /> : <p className="py-8 text-sm text-muted-foreground">所选日期内暂无可绘制的发货趋势。</p>}
      </section>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="按普通包裹实际出库数量排序。商品销售额使用订单快照价，不含每包 13 元物流费。"
          title={<span className="flex items-center gap-2"><Trophy aria-hidden="true" className="size-4 text-primary" />SKU 出库排名</span>}
        />
        <ResponsiveDataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>排名</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="text-right">出库件数</TableHead>
                <TableHead className="text-right">商品销售额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.skuSales.length ? (
                report.skuSales.map((row, index) => (
                  <TableRow key={row.skuId}>
                    <TableCell className="tabular-nums">{index + 1}</TableCell>
                    <TableCell className="font-semibold">{row.skuCode}</TableCell>
                    <TableCell>{row.skuName}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(row.revenueFen)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="h-28 text-center text-muted" colSpan={5}>
                    所选日期内暂无普通包裹出库。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          description="按最近 7 个完整自然日出库速度识别需要优先补货的 SKU。"
          title={<span className="flex items-center gap-2"><Boxes aria-hidden="true" className="size-4 text-primary" />库存覆盖风险</span>}
        />
        {coverageRisks.length > 0 ? (
          <ul className="divide-y divide-border">
            {coverageRisks.slice(0, 8).map((row) => (
              <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:px-5" key={row.skuId}>
                <div className="min-w-0"><p className="truncate font-semibold tabular-nums text-foreground">{row.skuCode}</p><p className="mt-0.5 truncate text-sm text-muted-foreground">{row.skuName}</p></div>
                <p className="text-sm tabular-nums text-foreground">可售 {row.availableQuantity} 件</p>
                <Badge className={row.alertLevel === "CRITICAL" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning"} variant="secondary">{row.coverageDays == null ? "暂无基线" : `预计 ${row.coverageDays} 天`}</Badge>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 py-6 text-sm text-muted-foreground" role="status">当前没有低库存覆盖风险。</p>}
      </WorkspacePanel>

      <WorkspacePanel className="overflow-hidden">
        <WorkspacePanelHeader
          title={
            <span className="flex items-center gap-2">
              <Store aria-hidden="true" className="size-4 text-primary" />
              店铺销量
            </span>
          }
        />
        <ResponsiveDataTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>店铺</TableHead>
                <TableHead className="text-right">订单</TableHead>
                <TableHead className="text-right">包裹</TableHead>
                <TableHead className="text-right">件数</TableHead>
                <TableHead className="text-right">商品销售额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.stores.length ? (
                report.stores.map((row) => (
                  <TableRow key={row.storeId}>
                    <TableCell className="font-medium">{row.storeName}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.orderCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.packageCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(row.revenueFen)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="h-28 text-center text-muted" colSpan={5}>
                    所选日期内暂无店铺出库。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResponsiveDataTable>
      </WorkspacePanel>

      <div className="grid gap-6 xl:grid-cols-2">
        <WorkspacePanel className="overflow-hidden">
          <WorkspacePanelHeader
            description="仅统计已发货补发，不计销售收入。"
            title="补发分析"
          />
          <ResponsiveDataTable>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>原因</TableHead>
                  <TableHead className="text-right">补发单</TableHead>
                  <TableHead className="text-right">件数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.replacements.length ? (
                  report.replacements.map((row) => (
                    <TableRow key={row.reason}>
                      <TableCell className="whitespace-normal">{row.reason}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.requestCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell className="h-28 text-center text-muted" colSpan={3}>
                      所选日期内暂无已发货补发。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ResponsiveDataTable>
        </WorkspacePanel>

        <WorkspacePanel className="overflow-hidden">
          <WorkspacePanelHeader
            description="余额按流水时间、线下收款按核准时间、线下退款按完成时间统计；极风物流费为加元，不混入本表。"
            title="人民币资金"
          />
          <dl className="divide-y divide-border px-4 sm:px-5">
            {[
              ["余额充值", report.funds.adminCreditsFen],
              ["余额人工扣减", report.funds.adminDebitsFen],
              ["订单余额消费", report.funds.orderDebitsFen],
              ["余额退款", report.funds.orderRefundsFen],
              ["已完成线下退款", report.funds.completedOfflineRefundsFen],
              ["已确认线下付款", report.funds.approvedOfflineFen],
              ["待收款", report.funds.pendingReceivableFen],
            ].map(([label, value]) => (
              <div className="flex min-h-12 items-center justify-between gap-4" key={String(label)}>
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="font-semibold tabular-nums text-ink">
                  {money(Number(value))}
                </dd>
              </div>
            ))}
          </dl>
          <div className="px-4 pb-4 sm:px-5">
            <Badge className="bg-primary-soft text-primary-hover" variant="secondary">
              全部金额均为人民币
            </Badge>
          </div>
        </WorkspacePanel>
      </div>
    </div>
  );
}
