import { NextRequest, NextResponse } from "next/server";
import { getBridge, removeIgnore } from "@/lib/stores/bridges";

interface Params { params: Promise<{ id: string; remote_jid: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id, remote_jid } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ok = removeIgnore(id, decodeURIComponent(remote_jid));
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
}
