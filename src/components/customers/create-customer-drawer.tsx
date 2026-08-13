import { Plus } from "lucide-react";

import { ActionForm } from "@/components/forms/action-form";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createCustomerWithStoreAction } from "@/modules/customers/actions";

function CreateCustomerForm() {
  return (
    <DrawerSection
      description="一次创建客户、唯一登录账号和首家 TEMU 店铺；创建原因会保留在审计日志中。"
      title="客户与首店资料"
    >
      <ActionForm
        action={createCustomerWithStoreAction}
        className="grid gap-4"
        submitLabel="创建客户与店铺"
      >
        <label className="space-y-2 text-sm font-medium text-foreground">
          客户编号
          <Input
            className="min-h-11"
            maxLength={40}
            name="code"
            placeholder="例如 OTTAWA-01"
            required
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          客户名称
          <Input
            className="min-h-11"
            maxLength={160}
            name="customerName"
            placeholder="店主或公司名称"
            required
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          店铺名称
          <Input
            className="min-h-11"
            maxLength={160}
            name="storeName"
            placeholder="TEMU 店铺名称"
            required
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          登录邮箱
          <Input
            autoComplete="email"
            className="min-h-11"
            name="email"
            placeholder="customer@example.com"
            required
            type="email"
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          初始密码
          <Input
            autoComplete="new-password"
            className="min-h-11"
            minLength={12}
            name="password"
            placeholder="至少 12 位"
            required
            type="password"
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          创建原因
          <Input
            className="min-h-11"
            maxLength={500}
            name="reason"
            placeholder="说明为什么要创建该客户账号"
            required
          />
        </label>
      </ActionForm>
    </DrawerSection>
  );
}

export function CreateCustomerDrawer({ first = false }: { first?: boolean }) {
  return (
    <EntityDrawer
      description="创建客户、唯一登录账号与首家店铺。"
      size="lg"
      title="新建客户"
      trigger={
        <Button className="min-h-11" variant={first ? "outline" : "default"}>
          <Plus aria-hidden="true" />
          {first ? "新建第一位客户" : "新建客户"}
        </Button>
      }
    >
      <CreateCustomerForm />
    </EntityDrawer>
  );
}
