import { ArrowRight, PackageSearch, Store, Upload } from "lucide-react";
import Link from "next/link";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel } from "@/components/layout/workspace-panel";

const quickLinks = [
  {
    description: "查看自己的成交价、可售库存和 SKU 状态。",
    href: "/portal/catalog",
    label: "进入货盘选品",
    icon: PackageSearch,
  },
  {
    description: "上传 TEMU 订单并自动识别 SKU、重复单和格式问题。",
    href: "/portal/imports/new",
    label: "上传 TEMU 订单",
    icon: Upload,
  },
  {
    description: "按店铺合并多个原始 Excel，统一进入结算。",
    href: "/portal/bulk-orders",
    label: "多店铺批量拿货",
    icon: Store,
  },
];

export default function CustomerPortalPage() {
  return (
    <div className="space-y-5">
      <PageHeading
        description="查看实时货盘，并按店铺提交拿货需求。"
        title="欢迎使用同舟行跨境"
      />

      <MetricStrip
        items={[
          { hint: "直接进入 SKU 与库存查看", label: "货盘入口", value: "1 个" },
          { hint: "支持单店上传和多店批量", label: "拿货方式", value: "2 种" },
          { hint: "关键按钮保持 44px 以上", label: "移动适配", value: "390 px" },
          { hint: "当前首页可直达的高频操作", label: "快捷入口", value: String(quickLinks.length) },
        ]}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {quickLinks.map((item) => (
          <WorkspacePanel className="transition-colors hover:border-primary/30 hover:bg-surface" key={item.href}>
            <Link className="flex min-h-[168px] items-start gap-4 p-5" href={item.href}>
              <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-hover">
                <item.icon className="size-5" />
              </span>
              <span className="flex-1">
                <strong className="block text-base text-ink">{item.label}</strong>
                <span className="mt-2 block text-sm leading-6 text-muted">{item.description}</span>
              </span>
              <ArrowRight className="mt-1 size-4 text-primary" />
            </Link>
          </WorkspacePanel>
        ))}
      </div>
    </div>
  );
}
