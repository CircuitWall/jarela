import { NextRequest, NextResponse } from "next/server";
import { deleteThread, getMessagesPage, getThread } from "@/lib/stores/threads";

type Params = { params: Promise<{ thread_id: string }> };

const DEFAULT_PAGE = 50;

export async function GET(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || DEFAULT_PAGE));
  const before = url.searchParams.get("before") ?? undefined;

  const { messages, has_more } = getMessagesPage(thread_id, limit, before);
  return NextResponse.json({
    ...thread,
    messages: messages.map((m) => ({
      id: m.msg_id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      tool_events: parseToolEvents(m.tool_events),
    })),
    has_more,
  });
}

function parseToolEvents(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const deleted = deleteThread(thread_id);
  if (!deleted) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
