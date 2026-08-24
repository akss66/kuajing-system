import { z } from "zod";

import { AccessError, requireAdmin } from "@/modules/identity/guards";
import { getCurrentPrincipal } from "@/modules/identity/principal";
import {
  exportJifengOrdersToXlsx,
  JifengExportError,
} from "@/modules/orders/jifeng-export";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 32 * 1024;
const dedupedOrderIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .transform((orderIds) => [...new Set(orderIds)])
  .pipe(z.array(z.string().uuid()).min(1).max(100));

const exportRequestSchema = z
  .object({
    orderIds: dedupedOrderIdsSchema,
  })
  .strict();

function emptyResponse(status: number) {
  return new Response(null, { status });
}

function exportFileName(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `jifeng-shipments-${year}${month}${day}.xlsx`;
}

export async function POST(request: Request) {
  try {
    await requireAdmin(() => getCurrentPrincipal(new Headers(request.headers)));
  } catch (error) {
    return emptyResponse(error instanceof AccessError ? error.status : 401);
  }

  let parsedRequest: z.infer<typeof exportRequestSchema>;
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_REQUEST_BYTES) return emptyResponse(400);

    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      return emptyResponse(400);
    }
    parsedRequest = exportRequestSchema.parse(JSON.parse(body));
  } catch {
    return emptyResponse(400);
  }

  try {
    const bytes = await exportJifengOrdersToXlsx(parsedRequest);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${exportFileName()}"`,
        "Content-Length": String(bytes.byteLength),
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    if (
      error instanceof JifengExportError &&
      error.code === "NO_EXPORTABLE_SHIPMENTS"
    ) {
      return emptyResponse(404);
    }
    return emptyResponse(500);
  }
}
