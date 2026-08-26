// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
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
    const storePicker = screen.getByRole("combobox", { name: "选择店铺" });
    expect(storePicker).toHaveAttribute(
      "data-slot",
      "select-trigger",
    );
    expect(storePicker).toHaveAttribute("data-portal-control", "store-picker");
    expect(storePicker).toHaveClass("min-h-12", "border-input");
    expect(document.querySelector("select[name='storeId']")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByLabelText("TEMU 订单 Excel")).toBeRequired();
    expect(screen.getByLabelText("TEMU 订单 Excel")).toHaveAttribute(
      "accept",
      ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const dropzone = screen.getByTestId("temu-workbook-dropzone");
    expect(dropzone).toHaveTextContent(
      "将 Excel 文件拖到这里",
    );
    expect(dropzone).toHaveAttribute("data-upload-dropzone");
    expect(dropzone).toHaveAttribute("data-drag-active", "false");
    expect(dropzone).toHaveAttribute("data-file-ready", "false");
    expect(screen.getByRole("button", { name: "上传并生成预览" })).toHaveClass(
      "min-h-12",
    );
    expect(screen.getByText("将 Excel 文件拖到这里")).toBeVisible();
    fireEvent.change(screen.getByLabelText("TEMU 订单 Excel"), {
      target: {
        files: [
          new File(["xlsx"], "订单导出.xlsx", {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
      },
    });
    expect(screen.getByText("订单导出.xlsx")).toBeVisible();

    fireEvent.dragEnter(dropzone, {
      dataTransfer: { files: [] },
    });
    expect(dropzone).toHaveAttribute("data-drag-active", "true");

    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [
          new File(["replacement"], "拖入订单.xlsx", {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
      },
    });
    expect(screen.getByText("拖入订单.xlsx")).toBeVisible();
    expect(dropzone).toHaveAttribute("data-drag-active", "false");
    expect(dropzone).toHaveAttribute("data-file-ready", "true");
    expect(dropzone.querySelector("[data-upload-icon]")).toBeInTheDocument();
    expect(screen.getByText(/系统不会保存原始 Excel 文件/)).toBeVisible();
  });
});
