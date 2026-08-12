import { notFound } from "next/navigation";

import { BulkOrderWorkspace } from "@/components/bulk-order/bulk-order-workspace";
import { getBulkWorkspaceDraft } from "@/modules/bulk-order/workspace-query";
import { requireCustomer } from "@/modules/identity/guards";
import { listActiveCustomerStores } from "@/modules/order-import/service";
import { getWalletPosition } from "@/modules/wallet/queries";

export default async function CustomerBulkOrderDraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const principal = await requireCustomer();
  const { draftId } = await params;

  const [draft, stores, walletPosition] = await Promise.all([
    getBulkWorkspaceDraft(principal.customerId, draftId).catch(() => null),
    listActiveCustomerStores(principal.customerId),
    getWalletPosition(principal.customerId),
  ]);

  if (!draft) notFound();

  return (
    <BulkOrderWorkspace
      key={draft.id}
      draft={{
        ...draft,
        createdAt: draft.createdAt.toISOString(),
        expiresAt: draft.expiresAt.toISOString(),
        updatedAt: draft.updatedAt.toISOString(),
      }}
      stores={stores}
      walletPosition={walletPosition}
    />
  );
}
