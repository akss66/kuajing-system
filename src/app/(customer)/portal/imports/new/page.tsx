import { FileSpreadsheet, ListChecks, Store, Upload } from "lucide-react";

import { TemuUploadForm } from "@/components/order-import/temu-upload-form";
import { requireCustomer } from "@/modules/identity/guards";
import { uploadTemuOrdersAction } from "@/modules/order-import/actions";
import { listActiveCustomerStores } from "@/modules/order-import/service";

const steps = [
  { icon: Store, label: "选择店铺", description: "关联订单归属" },
  { icon: Upload, label: "上传 Excel", description: "读取 TEMU 原始导出" },
  { icon: ListChecks, label: "核对预览", description: "确认映射和重复订单" },
];

export default async function NewTemuImportPage() {
  const principal = await requireCustomer();
  const stores = await listActiveCustomerStores(principal.customerId);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-primary">订单导入</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          上传 TEMU 订单
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          直接使用 TEMU 后台导出的 33 列订单文件，系统会识别 SKU、重复订单和格式问题。
        </p>
      </header>

      <ol className="grid gap-3 sm:grid-cols-3" aria-label="订单导入步骤">
        {steps.map((step, index) => (
          <li
            className="flex gap-3 rounded-[var(--radius-surface)] border border-border bg-background p-4"
            key={step.label}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft font-semibold text-primary-hover">
              {index + 1}
            </span>
            <span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <step.icon aria-hidden="true" className="size-4" />
                {step.label}
              </span>
              <span className="mt-1 block text-xs text-muted">{step.description}</span>
            </span>
          </li>
        ))}
      </ol>

      <section className="rounded-[var(--radius-surface)] border border-border bg-background p-4 sm:p-6">
        <div className="mb-5 flex items-start gap-3 border-b border-border pb-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-hover">
            <FileSpreadsheet aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-ink">选择原始订单文件</h2>
            <p className="mt-1 text-sm text-muted">仅支持 .xlsx，单个文件不超过 10 MB、10,000 行。</p>
          </div>
        </div>

        {stores.length ? (
          <TemuUploadForm action={uploadTemuOrdersAction} stores={stores} />
        ) : (
          <div className="rounded-lg border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">
            当前没有可用店铺，请联系管理员为你的客户账户启用店铺。
          </div>
        )}
      </section>
    </div>
  );
}
