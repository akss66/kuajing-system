"use client";

import { X } from "lucide-react";
import Image from "next/image";
import { Dialog } from "radix-ui";

import { Button } from "@/components/ui/button";

import { catalogThumbnailUrl } from "./catalog-asset-url";

type CatalogImagePreviewProps = {
  imageUrl: string;
  productName: string;
};

export function CatalogImagePreview({
  imageUrl,
  productName,
}: CatalogImagePreviewProps) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          aria-label={`查看 ${productName} 大图`}
          className="group relative size-12 shrink-0 overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface outline-none transition-[border-color] hover:border-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/22"
          type="button"
        >
          <Image
            alt={`${productName} 商品图片`}
            className="size-full object-cover transition-transform duration-150 group-hover:scale-105 motion-reduce:transition-none"
            decoding="async"
            fetchPriority="low"
            height={48}
            loading="lazy"
            sizes="48px"
            src={catalogThumbnailUrl(imageUrl)}
            unoptimized
            width={48}
          />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 gap-4 overflow-auto rounded-[var(--radius-surface)] border border-border bg-background p-4 shadow-xl outline-none sm:p-6">
          <div className="pr-12">
            <Dialog.Title className="font-heading text-lg font-semibold text-foreground">
              {productName} 图片预览
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              查看当前 SKU 的原始商品图片。
            </Dialog.Description>
          </div>
          <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-surface p-3">
            <Image
              alt={`${productName} 大图`}
              className="max-h-[calc(100dvh-10rem)] h-auto w-auto max-w-full object-contain"
              height={1200}
              loading="eager"
              sizes="(max-width: 768px) calc(100vw - 4rem), 800px"
              src={imageUrl}
              unoptimized
              width={1200}
            />
          </div>
          <Dialog.Close asChild>
            <Button
              aria-label="关闭图片预览"
              className="absolute right-3 top-3 size-11"
              size="icon-lg"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
