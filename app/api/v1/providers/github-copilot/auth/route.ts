import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  startDeviceFlow,
  pollDeviceFlow,
  getAuthStatus,
  clearStoredOAuthToken,
} from "@/lib/providers/github-copilot-auth";
import { validateBody } from "@/lib/api/responses";

const PutBody = z.object({
  device_code: z.string().min(1, "device_code required"),
});

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

export async function PUT(req: NextRequest) {
  // Poll endpoint: caller posts { device_code } repeatedly until completion.
  const body = await validateBody(req, PutBody);
  if (body instanceof NextResponse) return body;
  try {
    const result = await pollDeviceFlow(body.device_code);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
