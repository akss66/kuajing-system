// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ActionableEmptyState } from "@/components/management/actionable-empty-state";
import { DangerZone } from "@/components/management/danger-zone";
import { DrawerSection } from "@/components/management/drawer-section";
import { EntityDrawer } from "@/components/management/entity-drawer";

afterEach(() => {
  cleanup();
});

describe("management primitives", () => {
  it("opens a labelled drawer and restores focus to its trigger after close", async () => {
    render(
      <EntityDrawer
        trigger={<button type="button">编辑客户</button>}
        title="编辑客户"
        description="更新客户的基础资料。"
      >
        <button type="button">保存更改</button>
      </EntityDrawer>,
    );

    const trigger = screen.getByRole("button", { name: "编辑客户" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "编辑客户" });
    expect(dialog).toHaveAccessibleDescription("更新客户的基础资料。");
    expect(screen.getByRole("button", { name: "保存更改" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps entity drawers full width on mobile and uses the large desktop size", async () => {
    render(
      <EntityDrawer
        trigger={<button type="button">打开明细</button>}
        title="客户明细"
        size="lg"
      >
        内容
      </EntityDrawer>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开明细" }));

    const dialog = await screen.findByRole("dialog", { name: "客户明细" });
    expect(dialog).toHaveClass("w-full", "sm:max-w-[640px]");
  });

  it("groups drawer content in a labelled section", () => {
    render(
      <DrawerSection title="通知设置" description="配置向客户发送通知的方式。">
        <button type="button">保存通知设置</button>
      </DrawerSection>,
    );

    const section = screen.getByRole("region", { name: "通知设置" });
    expect(section).toHaveAccessibleDescription("配置向客户发送通知的方式。");
    expect(screen.getByRole("button", { name: "保存通知设置" })).toBeVisible();
  });

  it("marks destructive actions as a labelled danger zone", () => {
    render(
      <DangerZone description="删除后无法恢复该客户资料。">
        <button type="button">删除客户</button>
      </DangerZone>,
    );

    const zone = screen.getByRole("region", { name: "危险操作" });
    expect(zone).toHaveAccessibleDescription("删除后无法恢复该客户资料。");
    expect(screen.getByRole("button", { name: "删除客户" })).toBeVisible();
  });

  it("shows the supplied recovery action in an error empty state", () => {
    render(
      <ActionableEmptyState
        kind="error"
        title="加载客户失败"
        description="请检查网络后重试。"
        action={<button type="button">重新加载</button>}
      />,
    );

    const state = screen.getByRole("alert");
    expect(state).toHaveAccessibleName("加载客户失败");
    expect(state).toHaveAccessibleDescription("请检查网络后重试。");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
  });
});
