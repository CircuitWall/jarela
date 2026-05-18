import { NextRequest, NextResponse } from "next/server";
import {
  deleteThread,
  getMessagesAfter,
  getMessagesPage,
  getThread,
  type MessageRow,
} from "@/lib/stores/threads";

type Params = { params: Promise<{ thread_id: string }> };

const DEFAULT_PAGE = 50;

export async function GET(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || DEFAULT_PAGE));
  const before = url.searchParams.get("before") ?? undefined;
  const after  = url.searchParams.get("after")  ?? undefined;

  // `after` is a forward-fetch shortcut: caller (typically ChatView's
  // run-completion handler) already has the recent messages and just wants
  // the freshly-persisted ones. has_more is fixed to false because the
  // forward window is not paginated — caller already has everything older.
  let messages: MessageRow[];
  let has_more: boolean;
  if (after) {
    messages = getMessagesAfter(thread_id, after, limit);
    has_more = false;
  } else {
    const page = getMessagesPage(thread_id, limit, before);
    messages = page.messages;
    has_more = page.has_more;
  }

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
