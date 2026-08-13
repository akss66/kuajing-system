import { ActionForm } from "@/components/forms/action-form";
import { DrawerSection } from "@/components/management/drawer-section";
import { Input } from "@/components/ui/input";
import { createAdminAccountAction } from "@/modules/accounts/actions";

export function CreateAdminForm() {
  return (
    <DrawerSection
      title="管理员资料"
      description="只允许创建普通管理员，不提供创建或晋升超级管理员的入口。"
    >
      <ActionForm
        action={createAdminAccountAction}
        className="grid gap-4"
        submitLabel="创建管理员账号"
      >
        <label className="space-y-2 text-sm font-medium text-foreground">
          管理员姓名
          <Input
            className="min-h-11"
            name="displayName"
            placeholder="例如：运营值班管理员"
            required
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          登录邮箱
          <Input
            className="min-h-11"
            name="email"
            placeholder="ops@example.com"
            required
            type="email"
          />
        </label>
        <label className="space-y-2 text-sm font-medium text-foreground">
          初始密码
          <Input
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
            name="reason"
            placeholder="例如：新增白班值守管理员"
            required
          />
        </label>
      </ActionForm>
    </DrawerSection>
  );
}
