import { FileSpreadsheet } from "lucide-react";

import { MetricStrip } from "@/components/data-workspace/metric-strip";
import { PageHeading } from "@/components/layout/page-heading";
import { WorkspacePanel } from "@/components/layout/workspace-panel";
import { ImportProgress } from "@/components/order-import/import-progress";
import { TemuUploadForm } from "@/components/order-import/temu-upload-form";
import { uploadTemuOrdersAction } from "@/modules/order-import/actions";
import { requireCustomer } from "@/modules/identity/guards";
import { listActiveCustomerStores } from "@/modules/order-import/service";

export default async function NewTemuImportPage() {
  const principal = await requireCustomer();
  const stores = await listActiveCustomerStores(principal.customerId);

  return (
    <div className="space-y-5">
      <PageHeading
        description="直接使用 TEMU 后台导出的 33 列订单文件，系统会识别 SKU、重复订单和格式问题。"
        title="上传 TEMU 订单"
      />

      <MetricStrip
        items={[
          { hint: "当前客户可用的店铺", label: "店铺", value: String(stores.length) },
          { hint: "从店铺选择到确认提交", label: "步骤", value: "4" },
          { hint: "仅支持原始 .xlsx 文件", label: "格式", value: ".xlsx" },
          { hint: "单文件上限 10 MB / 20,000 行", label: "限制", value: "10 MB" },
        ]}
      />

      <ImportProgress currentStep={2} />

      <WorkspacePanel className="p-4 sm:p-6">
        <div className="mb-5 flex items-start gap-3 border-b border-border pb-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-hover">
            <FileSpreadsheet aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-ink">选择原始订单文件</h2>
            <p className="mt-1 text-sm text-muted">仅支持 .xlsx，单个文件不超过 10 MB、20,000 行。</p>
          </div>
        </div>

        {stores.length ? (
          <TemuUploadForm action={uploadTemuOrdersAction} stores={stores} />
        ) : (
          <div className="rounded-lg border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">
            当前没有可用店铺，请联系管理员为你的客户账户启用店铺。
          </div>
        )}
      </WorkspacePanel>
    </div>
  );
}
