import { NextResponse } from "next/server";
import {
  startDeviceFlow,
  pollDeviceFlow,
  getAuthStatus,
  clearStoredOAuthToken,
} from "@/lib/providers/github-copilot-auth";

// GET → auth status. POST → start device flow. DELETE → sign out.
export async function GET() {
  return NextResponse.json(getAuthStatus());
}

export async function POST() {
  try {
    const flow = await startDeviceFlow();
    return NextResponse.json(flow);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE() {
  const deleted = clearStoredOAuthToken();
  return NextResponse.json({ deleted });
}

export async function PUT(req: Request) {
  // Poll endpoint: caller posts { device_code } repeatedly until completion.
  try {
    const body = await req.json() as { device_code?: string };
    if (!body.device_code) return NextResponse.json({ error: "device_code required" }, { status: 400 });
    const result = await pollDeviceFlow(body.device_code);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
