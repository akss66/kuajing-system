// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { TemuUploadForm } from "@/components/order-import/temu-upload-form";

describe("TEMU upload form", () => {
  it("requires an owned store and xlsx file with mobile-sized controls", () => {
    render(
      <TemuUploadForm
        action={vi.fn()}
        stores={[
          { id: "store-1", name: "渥太华一店", platform: "TEMU" },
        ]}
      />,
    );

    expect(screen.getByLabelText("选择店铺")).toBeRequired();
    expect(screen.getByLabelText("TEMU 订单 Excel")).toBeRequired();
    expect(screen.getByLabelText("TEMU 订单 Excel")).toHaveAttribute(
      "accept",
      ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(screen.getByRole("button", { name: "上传并生成预览" })).toHaveClass(
      "min-h-11",
    );
    expect(screen.getByText(/系统不会保存原始 Excel 文件/)).toBeVisible();
  });
});
