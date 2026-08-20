"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type OperationsReportTrendPoint = {
  date: string;
  orderCount: number;
  revenueFen: number;
};

const compactNumber = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
  notation: "compact",
});

const money = new Intl.NumberFormat("zh-CN", {
  currency: "CNY",
  maximumFractionDigits: 0,
  notation: "compact",
  style: "currency",
});

export function OperationsReportTrend({
  series,
}: {
  series: OperationsReportTrendPoint[];
}) {
  const chartData = series.map((point) => ({
    ...point,
    dateLabel: point.date.slice(5).replace("-", "/"),
    revenueYuan: point.revenueFen / 100,
  }));

  return (
    <div aria-label="所选日期经营趋势图" className="h-64 min-w-0" role="img">
      <ResponsiveContainer height="100%" width="100%">
        <ComposedChart data={chartData} margin={{ bottom: 0, left: -12, right: 8, top: 12 }}>
          <CartesianGrid stroke="var(--merchant-panel-border)" strokeDasharray="3 4" vertical={false} />
          <XAxis axisLine={false} dataKey="dateLabel" fontSize={12} tickLine={false} />
          <YAxis
            axisLine={false}
            fontSize={12}
            tickFormatter={(value) => compactNumber.format(Number(value))}
            tickLine={false}
            yAxisId="orders"
          />
          <YAxis hide orientation="right" yAxisId="revenue" />
          <Tooltip
            contentStyle={{
              background: "var(--merchant-panel)",
              border: "1px solid var(--merchant-panel-border)",
              borderRadius: "var(--radius-control)",
              boxShadow: "0 8px 24px rgba(23, 36, 35, 0.12)",
            }}
            formatter={(value, name) =>
              name === "商品销售额"
                ? [money.format(Number(value)), name]
                : [`${Number(value)} 单`, name]
            }
            labelFormatter={(_, payload) => payload[0]?.payload.date ?? ""}
          />
          <Area
            dataKey="revenueYuan"
            fill="var(--tzx-primary-soft)"
            fillOpacity={0.8}
            name="商品销售额"
            stroke="var(--tzx-primary)"
            strokeWidth={2}
            type="monotone"
            yAxisId="revenue"
          />
          <Line
            activeDot={{ r: 4 }}
            dataKey="orderCount"
            dot={{ fill: "var(--merchant-panel)", r: 3, strokeWidth: 2 }}
            name="涉及拿货单数"
            stroke="var(--tzx-info)"
            strokeWidth={2}
            type="monotone"
            yAxisId="orders"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export type { OperationsReportTrendPoint };
