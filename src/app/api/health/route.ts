import { NextResponse } from "next/server";

import { checkDatabaseHealth } from "@/modules/system/health";

export async function GET() {
  try {
    await checkDatabaseHealth();
    return NextResponse.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" }, status: 200 },
    );
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { headers: { "Cache-Control": "no-store" }, status: 503 },
    );
  }
}
