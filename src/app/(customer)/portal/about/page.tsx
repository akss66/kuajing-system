import { Code2, MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";

import { PageHeading } from "@/components/layout/page-heading";
import { BRAND } from "@/shared/brand";

export const metadata: Metadata = { title: "关于系统" };

const systemDetails = [
  { label: "系统名称", value: "同舟行跨境" },
  { label: "当前版本", value: "V1.0.1" },
] as const;

export default function AboutSystemPage() {
  return (
    <div className="space-y-8" data-about-system>
      <PageHeading
        description="了解同舟行跨境的产品信息与开发者联系方式。"
        title="关于系统"
      />

      <section
        aria-label="系统信息"
        className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]"
      >
        <div
          className="flex min-h-40 flex-col items-center justify-center px-5 py-8 text-center sm:min-h-44 sm:px-7 sm:py-10"
          data-system-brand
        >
          <p className="text-xs font-semibold tracking-[0.12em] text-primary">系统信息</p>
          <div className="mt-3 flex items-center justify-center gap-3" data-system-brand-lockup>
            <Image
              alt=""
              className="h-10 w-auto shrink-0 object-contain sm:h-11"
              data-system-brand-logo
              height={656}
              src={BRAND.logoPath}
              width={683}
            />
            <h2 className="text-xl font-bold tracking-tight text-foreground">同舟行跨境</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            面向跨境商家的本地货盘与履约协作系统
          </p>
        </div>

        <dl className="grid border-t border-slate-100 bg-[var(--portal-subtle-surface)] sm:grid-cols-2">
          {systemDetails.map((detail, index) => (
            <div
              className={
                index === 0
                  ? "px-5 py-5 sm:px-7"
                  : "border-t border-slate-100 px-5 py-5 sm:border-l sm:border-t-0 sm:px-7"
              }
              key={detail.label}
            >
              <dt className="text-xs font-medium text-muted-foreground">{detail.label}</dt>
              <dd className="mt-1.5 text-base font-bold tracking-tight text-foreground">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        aria-label="开发者信息"
        className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgb(0_0_0/0.02)]"
      >
        <div className="grid lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex min-w-0 flex-col px-5 py-6 sm:px-7 sm:py-7 lg:justify-between lg:py-8">
            <div>
              <div className="flex items-center gap-4">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[var(--portal-focus-surface)] text-white">
                  <Code2 aria-hidden="true" className="size-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold tracking-tight text-foreground">开发者信息</h2>
                  <p className="mt-1 text-sm text-muted-foreground">产品体验与系统能力持续演进</p>
                </div>
              </div>

              <dl className="mt-8 space-y-6">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">产品设计与全栈开发</dt>
                  <dd className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">ZZY</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <MessageCircle aria-hidden="true" className="size-4 text-primary" />
                    联系方式
                  </dt>
                  <dd className="mt-1.5 text-base font-semibold text-foreground">WeChat QRCode</dd>
                </div>
              </dl>
            </div>

            <p className="mt-8 max-w-xl text-sm leading-6 text-muted-foreground">
              如需产品支持或交流建议，请使用微信扫描右侧二维码联系。
            </p>
          </div>

          <div className="flex items-center justify-center border-t border-slate-100 bg-[var(--portal-subtle-surface)] p-5 sm:p-7 lg:border-l lg:border-t-0 lg:p-8">
            <figure className="w-full max-w-64">
              <div className="rounded-2xl bg-white p-3 shadow-[0_2px_12px_rgb(0_0_0/0.04)] ring-1 ring-slate-100">
                <Image
                  alt="ZZY 微信二维码"
                  className="aspect-square h-auto w-full object-contain"
                  height={643}
                  loading="eager"
                  src="/images/zzy-wechat-qr.jpg"
                  unoptimized
                  width={643}
                />
              </div>
              <figcaption className="mt-3 text-center text-xs leading-5 text-muted-foreground">
                使用微信扫一扫
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <p className="pb-2 text-center text-[11px] font-medium tracking-[0.08em] text-muted-foreground">
        Designed &amp; Developed by ZZY
      </p>
    </div>
  );
}
