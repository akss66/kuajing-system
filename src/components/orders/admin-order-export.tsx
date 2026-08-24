"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const MAX_EXPORT_ORDERS = 100;

type ExportSelectionContextValue = {
  allOrderIds: string[];
  clear: () => void;
  isSelected: (orderId: string) => boolean;
  selectAll: () => void;
  selectedOrderIds: string[];
  toggle: (orderId: string) => void;
};

const ExportSelectionContext = createContext<ExportSelectionContextValue | null>(null);

function useExportSelection() {
  const value = useContext(ExportSelectionContext);
  if (!value) throw new Error("Order export controls must be rendered inside OrderExportProvider.");
  return value;
}

export function OrderExportProvider({
  children,
  orderIds,
}: {
  children: React.ReactNode;
  orderIds: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const allowedOrderIds = useMemo(() => orderIds.slice(0, MAX_EXPORT_ORDERS), [orderIds]);
  const allowedOrderIdSet = useMemo(() => new Set(allowedOrderIds), [allowedOrderIds]);

  const toggle = useCallback((orderId: string) => {
    if (!allowedOrderIdSet.has(orderId)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else if (next.size < MAX_EXPORT_ORDERS) next.add(orderId);
      return next;
    });
  }, [allowedOrderIdSet]);

  const value = useMemo<ExportSelectionContextValue>(() => ({
    allOrderIds: allowedOrderIds,
    clear: () => setSelected(new Set()),
    isSelected: (orderId) => selected.has(orderId),
    selectAll: () => setSelected(new Set(allowedOrderIds)),
    selectedOrderIds: allowedOrderIds.filter((orderId) => selected.has(orderId)),
    toggle,
  }), [allowedOrderIds, selected, toggle]);

  return <ExportSelectionContext.Provider value={value}>{children}</ExportSelectionContext.Provider>;
}

function filenameFromDisposition(disposition: string | null) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return "极风发货导出.xlsx";
    }
  }
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  return plain || "极风发货导出.xlsx";
}

export function OrderExportToolbar() {
  const { allOrderIds, clear, selectAll, selectedOrderIds } = useExportSelection();
  const [isExporting, setIsExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function exportSelected() {
    if (!selectedOrderIds.length || isExporting) return;
    setIsExporting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/orders/jifeng-export", {
        body: JSON.stringify({ orderIds: selectedOrderIds }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("EXPORT_FAILED");

      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filenameFromDisposition(response.headers.get("Content-Disposition"));
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage(`已导出 ${selectedOrderIds.length} 个拿货单。`);
    } catch {
      setMessage("导出失败，请刷新后重试；若仍失败，请联系管理员检查订单收件信息。");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <section
      aria-label="极风发货导出"
      className="flex w-full flex-col gap-3 border-b border-border bg-surface-muted/55 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">极风发货导出</p>
        <p className="mt-0.5 text-xs text-muted">
          已选择 {selectedOrderIds.length} 个拿货单 · 单次最多 {MAX_EXPORT_ORDERS} 个
        </p>
        {message ? <p aria-live="polite" className="mt-1 text-xs text-muted">{message}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!allOrderIds.length || isExporting} onClick={selectAll} size="sm" type="button" variant="outline">
          全选当前结果
        </Button>
        <Button disabled={!selectedOrderIds.length || isExporting} onClick={clear} size="sm" type="button" variant="ghost">
          清除选择
        </Button>
        <Button disabled={!selectedOrderIds.length || isExporting} onClick={exportSelected} size="sm" type="button">
          {isExporting ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Download aria-hidden="true" />}
          {isExporting ? "正在生成" : "导出所选拿货单"}
        </Button>
      </div>
    </section>
  );
}

export function OrderExportCheckbox({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const { isSelected, toggle } = useExportSelection();
  return (
    <Checkbox
      aria-label={`选择拿货单 ${orderNumber}`}
      checked={isSelected(orderId)}
      onCheckedChange={() => toggle(orderId)}
    />
  );
}
