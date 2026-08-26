// @vitest-environment jsdom
/* eslint-disable @next/next/no-img-element */

import "@testing-library/jest-dom/vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: ({
    alt,
    priority: _priority,
    src,
    unoptimized: _unoptimized,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    priority?: boolean;
    src: string;
    unoptimized?: boolean;
  }) => {
    void _priority;
    void _unoptimized;
    return <img alt={alt} src={src} {...props} />;
  },
}));

import AboutSystemPage from "@/app/(customer)/portal/about/page";

describe("about system page", () => {
  it("presents the product, developer, version, and WeChat contact details", () => {
    render(<AboutSystemPage />);

    expect(screen.getByRole("heading", { level: 1, name: "关于系统" })).toBeVisible();

    const systemCard = screen.getByRole("region", { name: "系统信息" });
    expect(within(systemCard).getAllByText("同舟行跨境")).toHaveLength(2);
    expect(within(systemCard).getByText("V1.0.1")).toBeVisible();
    expect(within(systemCard).queryByText("正式版本")).not.toBeInTheDocument();
    const brandArea = systemCard.querySelector<HTMLElement>("[data-system-brand]");
    const brandLogo = systemCard.querySelector<HTMLImageElement>("[data-system-brand-logo]");
    const brandLockup = systemCard.querySelector<HTMLElement>("[data-system-brand-lockup]");
    expect(brandArea).toHaveClass("min-h-40", "flex-col");
    expect(brandLogo).toBeVisible();
    expect(brandLockup).toContainElement(brandLogo);
    expect(within(brandLockup as HTMLElement).getByRole("heading", { name: "同舟行跨境" })).toBeVisible();
    expect(brandLogo?.parentElement).not.toHaveClass(
      "rounded-xl",
      "bg-[var(--portal-icon-surface)]",
      "p-2.5",
    );

    const developerCard = screen.getByRole("region", { name: "开发者信息" });
    expect(within(developerCard).getByText("产品设计与全栈开发")).toBeVisible();
    expect(within(developerCard).getByText("ZZY")).toBeVisible();
    expect(within(developerCard).getByText("WeChat QRCode")).toBeVisible();
    expect(within(developerCard).getByRole("img", { name: "ZZY 微信二维码" })).toHaveAttribute(
      "src",
      "/images/zzy-wechat-qr.jpg",
    );
    expect(screen.getByText("Designed & Developed by ZZY")).toBeVisible();
  });

  it("keeps the bundled QR image byte-identical to the approved source", () => {
    const asset = readFileSync(join(process.cwd(), "public/images/zzy-wechat-qr.jpg"));
    const sha256 = createHash("sha256").update(asset).digest("hex");

    expect(asset.byteLength).toBe(157_051);
    expect(sha256).toBe("0d992e0c8d6884a7360a7847607755e93897553a04650ed51f5a63ca49e664b1");
  });
});
