import { NextResponse } from "next/server";
import { z } from "zod";
import { listWhitelist, addToWhitelist } from "@/lib/stores/access";

export async function GET() {
  return NextResponse.json(listWhitelist());
}

const addSchema = z.object({
  identity: z.string().min(1),
  display_name: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  try {
    const body = addSchema.parse(await req.json());
    const entry = addToWhitelist(body.identity, body.display_name ?? null);
    return NextResponse.json(entry, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
