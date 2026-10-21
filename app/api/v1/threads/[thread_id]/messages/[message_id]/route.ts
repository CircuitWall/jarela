import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody } from "@/lib/api/responses";
import { setMessageHiddenFromChat } from "@/lib/stores/threads";

type Params = { params: Promise<{ thread_id: string; message_id: string }> };

const Body = z.strictObject({ hidden_from_chat: z.boolean() });

export async function PATCH(req: NextRequest, { params }: Params) {
  const { thread_id, message_id } = await params;
  const body = await validateBody(req, Body);
  if (body instanceof NextResponse) return body;
  const updated = setMessageHiddenFromChat(thread_id, message_id, body.hidden_from_chat);
  if (!updated) return NextResponse.json({ error: "Message not found in thread" }, { status: 404 });
  return NextResponse.json({ updated: true });
}
