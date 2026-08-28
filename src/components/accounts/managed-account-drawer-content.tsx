import { LockKeyhole, Store } from "lucide-react";
import Link from "next/link";

import { ActionForm } from "@/components/forms/action-form";
import { ConfirmedActionForm } from "@/components/forms/confirmed-action-form";
import { DangerZone } from "@/components/management/danger-zone";
import { DrawerSection } from "@/components/management/drawer-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  resetManagedAccountPasswordAction,
  setCustomerAiSkuMatchAccessAction,
  setManagedAccountStatusAction,
  updateManagedAccountAction,
} from "@/modules/accounts/actions";
import type { ManagedAccountSummary } from "@/modules/accounts/queries";

import { accountKindLabel, accountStatusLabel, formatAccountDateTime } from "./workspace-copy";

function OverviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

function ProtectedAccountNotice() {
  return (
    <div className="space-y-3 bg-muted/45 p-4">
      <Badge className="gap-1 bg-primary/10 text-primary" variant="secondary">
        <LockKeyhole aria-hidden="true" />
        受保护
      </Badge>
      <p className="text-sm leading-6 text-muted-foreground">
        这是系统初始化的超级管理员，只读且不可修改资料、重置密码、停用、删除或降级。
      </p>
    </div>
  );
}

function AccountProfileForm({ account }: { account: ManagedAccountSummary }) {
  return (
    <ActionForm action={updateManagedAccountAction} className="grid gap-4" submitLabel="保存资料">
      <input name="userId" type="hidden" value={account.userId} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        姓名
        <Input className="min-h-11" defaultValue={account.displayName} name="displayName" required />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        账号邮箱
        <Input className="min-h-11" defaultValue={account.email} name="email" required type="email" />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        修改原因
        <Input className="min-h-11" name="reason" placeholder="例如：修正姓名或邮箱" required />
      </label>
    </ActionForm>
  );
}

function PasswordResetForm({ account }: { account: ManagedAccountSummary }) {
  return (
    <ConfirmedActionForm
      action={resetManagedAccountPasswordAction}
      className="grid gap-4"
      confirmDescription={`将为 ${account.displayName} 设置新密码。现有密码会立即失效，本次原因将写入审计日志。`}
      confirmLabel="重置密码"
      confirmTitle="确认重置这个账号的密码？"
      submitLabel="重置密码"
      variant="outline"
    >
      <input name="userId" type="hidden" value={account.userId} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        新密码
        <Input className="min-h-11" minLength={12} name="newPassword" placeholder="至少 12 位" required type="password" />
      </label>
      <label className="space-y-2 text-sm font-medium text-foreground">
        重置原因
        <Input className="min-h-11" name="reason" placeholder="例如：重新发放初始密码" required />
      </label>
    </ConfirmedActionForm>
  );
}

function AccountStatusForm({ account }: { account: ManagedAccountSummary }) {
  const disabling = account.status === "ACTIVE";
  const nextStatus = disabling ? "DISABLED" : "ACTIVE";
  const actionLabel = disabling ? "停用账号" : "恢复账号";

  return (
    <ConfirmedActionForm
      action={setManagedAccountStatusAction}
      className="grid gap-4"
      confirmDescription={
        disabling
          ? "停用后该账号的现有会话会立即失效，但历史订单、客户关系和审计日志不会删除。"
          : "恢复后该账号可以重新登录系统，原有数据和审计记录保持不变。"
      }
      confirmLabel={actionLabel}
      confirmTitle={disabling ? "确认停用这个账号？" : "确认恢复这个账号？"}
      submitLabel={actionLabel}
    >
      <input name="status" type="hidden" value={nextStatus} />
      <input name="userId" type="hidden" value={account.userId} />
      <label className="space-y-2 text-sm font-medium text-foreground">
        操作原因
        <Input className="min-h-11" name="reason" placeholder={disabling ? "例如：人员离职" : "例如：恢复值班权限"} required />
      </label>
      <p className="text-sm text-muted-foreground">当前状态：{accountStatusLabel(account.status)}</p>
    </ConfirmedActionForm>
  );
}

function AiSkuMatchAccessForm({ account }: { account: ManagedAccountSummary }) {
  const enabling = !account.aiSkuMatchEnabled;
  const actionLabel = enabling ? "开放智能核单" : "关闭智能核单";

  return (
    <ConfirmedActionForm
      action={setCustomerAiSkuMatchAccessAction}
      className="grid gap-4"
      confirmDescription={
        enabling
          ? "开放后，该客户可在订单预览中主动请求 DeepSeek 辅助排序候选 SKU；建议不会自动修改订单。"
          : "关闭后，该客户立即回到现有手工核单流程；历史审计记录仍会保留。"
      }
      confirmLabel={actionLabel}
      confirmTitle={
        enabling
          ? "确认向这个客户开放智能核单试用？"
          : "确认关闭这个客户的智能核单试用？"
      }
      submitLabel={actionLabel}
      variant="outline"
    >
      <input name="enabled" type="hidden" value={String(enabling)} />
      <input name="userId" type="hidden" value={account.userId} />
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span>当前状态</span>
        <Badge variant="outline">
          {account.aiSkuMatchEnabled ? "已开放" : "当前未开放"}
        </Badge>
      </div>
      <label className="space-y-2 text-sm font-medium text-foreground">
        操作原因
        <Input
          className="min-h-11"
          maxLength={500}
          name="reason"
          placeholder={enabling ? "例如：首批试用客户" : "例如：结束试用"}
          required
        />
      </label>
    </ConfirmedActionForm>
  );
}

export function ManagedAccountDrawerContent({ account }: { account: ManagedAccountSummary }) {
  return (
    <>
      <DrawerSection title="账号概览">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
          <OverviewItem label="账号邮箱" value={account.email} />
          <OverviewItem label="角色" value={accountKindLabel(account.kind)} />
          <OverviewItem label="状态" value={accountStatusLabel(account.status)} />
          <OverviewItem label="最近登录" value={formatAccountDateTime(account.lastLoginAt)} />
        </dl>
        {account.customerId ? (
          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Store aria-hidden="true" className="size-4 text-primary" />
              <span>{account.customerName}</span>
              <span className="text-muted-foreground">{account.storeCount} 家店铺</span>
            </div>
            <Button asChild className="min-h-11" variant="outline">
              <Link href={`/admin/customers/${account.customerId}`}>查看客户详情</Link>
            </Button>
          </div>
        ) : null}
      </DrawerSection>

      {account.kind === "SUPER_ADMIN" ? (
        <ProtectedAccountNotice />
      ) : (
        <>
          <DrawerSection title="基本资料" description="仅维护登录身份；客户业务资料请前往客户详情。">
            <AccountProfileForm account={account} />
          </DrawerSection>
          {account.kind === "CUSTOMER" ? (
            <DrawerSection
              description="仅超级管理员可逐客户开放；全局开关关闭时此授权不会生效。"
              title="智能核单试用"
            >
              <AiSkuMatchAccessForm account={account} />
            </DrawerSection>
          ) : null}
          <DrawerSection title="登录安全" description="重置密码需要填写原因并再次确认。">
            <PasswordResetForm account={account} />
          </DrawerSection>
          <DangerZone
            description={
              account.status === "ACTIVE"
                ? "停用将立即撤销该账号的全部现有会话；必须填写审计原因并再次确认。"
                : "恢复后账号可以重新登录；必须填写审计原因并再次确认。"
            }
          >
            <AccountStatusForm account={account} />
          </DangerZone>
        </>
      )}
    </>
  );
}
