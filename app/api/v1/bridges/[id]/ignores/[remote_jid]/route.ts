import { NextRequest, NextResponse } from "next/server";
import { getBridge, removeIgnore } from "@/lib/stores/bridges";
import { errorResponse } from "@/lib/api/responses";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

interface Params { params: Promise<{ id: string; remote_jid: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id, remote_jid } = await params;
  if (!getBridge(id)) return errorResponse(NOT_FOUND_ERRORS.LEGACY, 404);
  const ok = removeIgnore(id, decodeURIComponent(remote_jid));
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
}
