import { NextResponse } from "next/server";

import { checkDatabaseHealth } from "@/modules/system/health";

function releaseIdentity() {
  return {
    revision: process.env.RELEASE_SHA?.trim() || null,
    version: process.env.APP_VERSION?.trim() || "development",
  };
}

export async function GET() {
  try {
    await checkDatabaseHealth();
    return NextResponse.json(
      { status: "ok", ...releaseIdentity() },
      { headers: { "Cache-Control": "no-store" }, status: 200 },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable", ...releaseIdentity() },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
