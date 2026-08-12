import { notFound } from "next/navigation";

import { AdminSettlementReview } from "@/components/settlement/admin-settlement-review";
import { getAdminSettlementBatchDetail } from "@/modules/settlement/admin-queries";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

function dateTime(value: Date | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: BUSINESS_TIME_ZONE,
  }).format(value);
}

export default async function AdminSettlementBatchDetailPage({
  params,
}: {
  params: Promise<{ settlementId: string }>;
}) {
  const { settlementId } = await params;
  const detail = await getAdminSettlementBatchDetail(settlementId);
  if (!detail) notFound();

  return (
    <AdminSettlementReview
      auditEntries={detail.auditEntries.map((entry) => ({
        ...entry,
        createdAtLabel: dateTime(entry.createdAt),
      }))}
      batch={{
        ...detail.batch,
        paidAtLabel: dateTime(detail.batch.paidAt),
        paymentReportedAtLabel: dateTime(detail.batch.paymentReportedAt),
        reviewable: detail.batch.status === "PAYMENT_REPORTED",
      }}
      claim={
        detail.claim
          ? {
              ...detail.claim,
              createdAtLabel: dateTime(detail.claim.createdAt),
            }
          : null
      }
      orders={detail.orders}
    />
  );
}
