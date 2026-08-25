import { NextResponse } from "next/server";

import { getRuntimeHealth } from "@/modules/system/health";

function releaseIdentity() {
  return {
    revision: process.env.RELEASE_SHA?.trim() || null,
    version: process.env.APP_VERSION?.trim() || "development",
  };
}

export async function GET() {
  try {
    const runtime = await getRuntimeHealth();
    return NextResponse.json(
      {
        components: {
          database: runtime.database,
          worker: runtime.worker,
        },
        status: runtime.status,
        ...releaseIdentity(),
      },
      { headers: { "Cache-Control": "no-store" }, status: 200 },
    );
  } catch {
    return NextResponse.json(
      {
        components: {
          database: "unavailable",
          worker: "unknown",
        },
        status: "unavailable",
        ...releaseIdentity(),
      },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
