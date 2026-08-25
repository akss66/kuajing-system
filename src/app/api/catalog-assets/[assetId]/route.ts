import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/db/client";
import { catalogAssets, products, skus } from "@/db/schema";
import { getCurrentPrincipal } from "@/modules/identity/principal";
import { openCatalogAsset } from "@/modules/feishu/asset-storage";

export const runtime = "nodejs";

async function findAdminAsset(assetId: string) {
  const [asset] = await db
    .select({
      id: catalogAssets.id,
      contentSha256: catalogAssets.contentSha256,
      mimeType: catalogAssets.mimeType,
      storageKey: catalogAssets.storageKey,
    })
    .from(catalogAssets)
    .where(eq(catalogAssets.id, assetId))
    .limit(1);

  return asset ?? null;
}

async function findCustomerAsset(assetId: string) {
  const [asset] = await db
    .select({
      id: catalogAssets.id,
      contentSha256: catalogAssets.contentSha256,
      mimeType: catalogAssets.mimeType,
      storageKey: catalogAssets.storageKey,
    })
    .from(catalogAssets)
    .innerJoin(skus, eq(skus.imageAssetId, catalogAssets.id))
    .innerJoin(products, eq(products.id, skus.productId))
    .where(
      and(
        eq(catalogAssets.id, assetId),
        eq(products.status, "ACTIVE"),
        eq(skus.lifecycleStatus, "ACTIVE"),
        isNull(skus.archivedAt),
      ),
    )
    .limit(1);

  return asset ?? null;
}

function jsonError(status: number, code: string) {
  return Response.json({ code }, { status });
}

type AssetVariant = "original" | "thumbnail";

const PRIVATE_ASSET_CACHE_CONTROL = "private, max-age=3600, must-revalidate";

function parseVariant(request: Request): AssetVariant | null {
  const variant = new URL(request.url).searchParams.get("variant");
  if (variant === null || variant === "original") return "original";
  if (variant === "thumbnail") return "thumbnail";
  return null;
}

function assetEtag(contentSha256: string, variant: AssetVariant) {
  return `"catalog-${contentSha256}-${variant}"`;
}

function requestMatchesEtag(request: Request, etag: string) {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!ifNoneMatch) return false;

  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

function assetHeaders(etag: string) {
  return {
    "Cache-Control": PRIVATE_ASSET_CACHE_CONTROL,
    ETag: etag,
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
  };
}

async function renderVariant(
  bytes: Uint8Array,
  contentType: string,
  variant: AssetVariant,
) {
  if (variant === "original") {
    return { bytes: Buffer.from(bytes), contentType };
  }

  const thumbnail = await sharp(bytes, { failOn: "error", limitInputPixels: 25_000_000 })
    .rotate()
    .resize({
      fit: "inside",
      height: 96,
      kernel: sharp.kernel.lanczos3,
      width: 96,
      withoutEnlargement: true,
    })
    .webp({ effort: 4, quality: 76 })
    .toBuffer();

  return { bytes: thumbnail, contentType: "image/webp" };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const principal = await getCurrentPrincipal(new Headers(request.headers));
  if (!principal) {
    return jsonError(401, "UNAUTHENTICATED");
  }

  const variant = parseVariant(request);
  if (!variant) {
    return jsonError(400, "INVALID_VARIANT");
  }

  const { assetId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
    return jsonError(404, "NOT_FOUND");
  }
  const asset =
    principal.kind === "CUSTOMER"
      ? await findCustomerAsset(assetId)
      : await findAdminAsset(assetId);

  if (!asset) {
    return jsonError(404, "NOT_FOUND");
  }

  const etag = assetEtag(asset.contentSha256, variant);
  if (requestMatchesEtag(request, etag)) {
    return new Response(null, {
      headers: assetHeaders(etag),
      status: 304,
    });
  }

  try {
    const opened = await openCatalogAsset(asset.storageKey);
    const rendered = await renderVariant(opened.bytes, opened.contentType, variant);
    return new Response(rendered.bytes, {
      headers: {
        ...assetHeaders(etag),
        "Content-Length": String(rendered.bytes.byteLength),
        "Content-Type": rendered.contentType,
      },
      status: 200,
    });
  } catch {
    return jsonError(404, "NOT_FOUND");
  }
}
