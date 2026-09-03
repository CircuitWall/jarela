import { NextRequest, NextResponse } from "next/server";
import { getFlow } from "@/lib/integrations/linkedin-oauth";

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state") || "";
  const flow = getFlow("personal", state);
  if (!flow) return NextResponse.json({ error: "OAuth session not found or expired" }, { status: 404 });
  return NextResponse.json({ status: flow.status, error: flow.error });
}
