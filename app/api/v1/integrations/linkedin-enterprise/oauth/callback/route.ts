import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, getFlow, saveToken, updateFlow } from "@/lib/integrations/linkedin-oauth";

export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state") || "";
  const flow = getFlow("enterprise", state);
  if (!flow) return NextResponse.json({ error: "OAuth session not found or expired" }, { status: 400 });
  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError) { updateFlow("enterprise", state, { status: "error", error: providerError }); return NextResponse.json({ error: providerError }, { status: 400 }); }
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json({ error: "authorization code missing" }, { status: 400 });
  try { const token = await exchangeCode(flow, code); saveToken("enterprise", flow, token); updateFlow("enterprise", state, { status: "done" }); return NextResponse.json({ ok: true }); }
  catch (error) { const message = error instanceof Error ? error.message : "token exchange failed"; updateFlow("enterprise", state, { status: "error", error: message }); return NextResponse.json({ error: message }, { status: 502 }); }
}
