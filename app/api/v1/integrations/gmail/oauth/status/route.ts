import { NextRequest, NextResponse } from "next/server";
import { getFlow } from "@/lib/integrations/gmail-oauth";

// GET /api/v1/integrations/gmail/oauth/status?state=…
// Returns { status: "pending"|"done"|"error"|"unknown", error? }

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state") ?? "";
  if (!state) return NextResponse.json({ status: "unknown" }, { status: 400 });
  const flow = getFlow(state);
  if (!flow) return NextResponse.json({ status: "unknown" });
  return NextResponse.json({ status: flow.status, error: flow.error });
}
