import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addIgnore, getBridge, listIgnores, type BridgeIgnoreRow } from "@/lib/stores/bridges";
import { errorMessage } from "@/lib/utils/error";

interface Params { params: Promise<{ id: string }> }

function toResponse(r: BridgeIgnoreRow) {
  return {
    id: r.id,
    bridge_id: r.bridge_id,
    remote_jid: r.remote_jid,
    label: r.label,
    created_at: r.created_at,
  };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listIgnores(id).map(toResponse));
}

// The catch-all sentinel ('*') is deliberately rejected here — ignoring
// the catch-all would silently mute an entire bridge, which is what
// disabling or deleting the catch-all route already achieves cleanly.
const CreateSchema = z.object({
  remote_jid: z.string().trim().min(3).refine((v) => v !== "*", {
    message: "Cannot ignore the catch-all sentinel ('*'). Delete the catch-all route instead.",
  }),
  label: z.string().trim().max(120).optional().nullable(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }

  try {
    const row = addIgnore({
      bridge_id: id,
      remote_jid: parsed.data.remote_jid,
      label: parsed.data.label ?? null,
    });
    return NextResponse.json(toResponse(row), { status: 201 });
  } catch (err) {
    const m = errorMessage(err);
    if (/UNIQUE/.test(m)) {
      return NextResponse.json(
        { error: "That chat is already on the ignore list." },
        { status: 409 },
      );
    }
    throw err;
  }
}
