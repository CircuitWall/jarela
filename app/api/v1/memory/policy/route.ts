import { NextResponse } from "next/server";
import { z } from "zod";
import { getMemoryPolicy, setMemoryPolicy } from "@/lib/stores/app-settings";

const Body = z.object({ policy: z.enum(["important", "balanced", "detailed"]) });

export function GET() {
  return NextResponse.json({ policy: getMemoryPolicy() });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  return NextResponse.json({ policy: setMemoryPolicy(parsed.data.policy) });
}