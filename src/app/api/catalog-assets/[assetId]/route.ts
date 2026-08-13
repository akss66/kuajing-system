import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { catalogAssets, products, skus } from "@/db/schema";
import { getCurrentPrincipal } from "@/modules/identity/principal";
import { openCatalogAsset } from "@/modules/feishu/asset-storage";

export const runtime = "nodejs";

async function findAdminAsset(assetId: string) {
  const [asset] = await db
    .select({
      id: catalogAssets.id,
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
        eq(skus.saleStatus, "SELLABLE"),
      ),
    )
    .limit(1);

  return asset ?? null;
}

function jsonError(status: number, code: string) {
  return Response.json({ code }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const principal = await getCurrentPrincipal(new Headers(request.headers));
  if (!principal) {
    return jsonError(401, "UNAUTHENTICATED");
  }

  const { assetId } = await params;
  const asset =
    principal.kind === "CUSTOMER"
      ? await findCustomerAsset(assetId)
      : await findAdminAsset(assetId);

  if (!asset) {
    return jsonError(404, "NOT_FOUND");
  }

  try {
    const opened = await openCatalogAsset(asset.storageKey);
    return new Response(Buffer.from(opened.bytes), {
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(opened.bytes.byteLength),
        "Content-Type": opened.contentType,
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  } catch {
    return jsonError(404, "NOT_FOUND");
  }
}
