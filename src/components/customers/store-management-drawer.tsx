"use client";

import { Plus, Store } from "lucide-react";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { DangerZone } from "@/components/management/danger-zone";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createStoreAction,
  setStoreStatusAction,
  updateStoreAction,
} from "@/modules/customers/actions";
import type { getCustomerManagementDetail } from "@/modules/customers/queries";

type CustomerDetail = Awaited<ReturnType<typeof getCustomerManagementDetail>>;
type ManagedStore = CustomerDetail["stores"][number];

function StoreFields({ store }: { store?: ManagedStore }) {
  return (
    <>
      <label className="space-y-2 text-sm font-medium text-foreground">
        店铺名称
        <Input
          className="min-h-11"
          defaultValue={store?.name ?? ""}
          maxLength={160}
          name="name"
          placeholder="例如：TEMU 加拿大二店"
          required
        />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        平台
        <Input
          className="min-h-11"
          defaultValue={store?.platform ?? "TEMU"}
          maxLength={40}
          name="platform"
          required
        />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        外部店铺编号
        <Input
          className="min-h-11"
          defaultValue={store?.externalStoreCode ?? ""}
          maxLength={120}
          name="externalStoreCode"
          placeholder="例如：TEMU-CA-002"
        />
      </label>
    </>
  );
}

function CreateStoreForm({ customerId }: { customerId: string }) {
  return (
    <DrawerSection
      description="新店默认启用；创建原因会写入审计日志。"
      title="店铺资料"
    >
      <ActionForm action={createStoreAction} className="grid gap-4" submitLabel="创建店铺">
        <input name="customerId" type="hidden" value={customerId} />
        <StoreFields />
        <label className="space-y-2 text-sm font-medium text-foreground">
          创建原因
          <Input
            className="min-h-11"
            maxLength={500}
            name="reason"
            placeholder="例如：新增加拿大站点店铺"
            required
          />
        </label>
      </ActionForm>
    </DrawerSection>
  );
}

function UpdateStoreForm({ customerId, store }: { customerId: string; store: ManagedStore }) {
  return (
    <ActionForm action={updateStoreAction} className="grid gap-4" submitLabel="保存店铺资料">
      <input name="customerId" type="hidden" value={customerId} />
      <input name="storeId" type="hidden" value={store.id} />
      <StoreFields store={store} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        修改原因
        <Input
          className="min-h-11"
          maxLength={500}
          name="reason"
          placeholder="例如：修正店铺名称或外部编号"
          required
        />
      </label>
    </ActionForm>
  );
}

function StoreStatusForm({ customerId, store }: { customerId: string; store: ManagedStore }) {
  const disabling = store.status === "ACTIVE";
  const nextStatus = disabling ? "DISABLED" : "ACTIVE";
  const actionLabel = disabling ? "停用店铺" : "恢复店铺";

  return (
    <ConfirmedActionForm
      action={setStoreStatusAction}
      className="grid gap-4"
      confirmDescription={
        disabling
          ? `停用 ${store.name} 后将禁止新拿货；历史订单、结算和审计记录会继续保留。`
          : `恢复 ${store.name} 后，该店铺可以重新导入订单并发起拿货。`
      }
      confirmLabel={actionLabel}
      confirmTitle={disabling ? "确认停用这家店铺？" : "确认恢复这家店铺？"}
      submitLabel={actionLabel}
    >
      <input name="customerId" type="hidden" value={customerId} />
      <input name="status" type="hidden" value={nextStatus} />
      <input name="storeId" type="hidden" value={store.id} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        操作原因
        <Input
          className="min-h-11"
          maxLength={500}
          name="reason"
          placeholder={disabling ? "例如：暂停接单" : "例如：恢复营业"}
          required
        />
      </label>
    </ConfirmedActionForm>
  );
}

export function StoreManagementDrawer({
  customerId,
  store,
}: {
  customerId: string;
  store?: ManagedStore;
}) {
  if (!store) {
    return (
      <EntityDrawer
        description="为当前客户新增一家独立管理的店铺。"
        size="lg"
        title="新增店铺"
        trigger={
          <Button className="min-h-11">
            <Plus aria-hidden="true" />
            新增店铺
          </Button>
        }
      >
        <CreateStoreForm customerId={customerId} />
      </EntityDrawer>
    );
  }

  return (
    <EntityDrawer
      description="资料维护与启停操作分区呈现，所有变更都需要填写原因。"
      size="lg"
      title={`管理店铺 · ${store.name}`}
      trigger={
        <Button
          aria-label={`管理店铺 ${store.name}`}
          className="min-h-11"
          variant="outline"
        >
          <Store aria-hidden="true" />
          管理
        </Button>
      }
    >
      <DrawerSection description="更新名称、平台与外部编号。" title="基本资料">
        <UpdateStoreForm customerId={customerId} store={store} />
      </DrawerSection>
      <DangerZone
        description={
          store.status === "ACTIVE"
            ? "停用后该店铺不能新建拿货单；必须填写审计原因并再次确认。"
            : "恢复后该店铺可以重新接单；必须填写审计原因并再次确认。"
        }
      >
        <StoreStatusForm customerId={customerId} store={store} />
      </DangerZone>
    </EntityDrawer>
  );
}
