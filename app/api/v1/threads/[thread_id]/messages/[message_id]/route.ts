import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody, errorResponse } from "@/lib/api/responses";
import { setMessageHiddenFromChat } from "@/lib/stores/threads";
import { NOT_FOUND_ERRORS } from "@/lib/api/errors";

type Params = { params: Promise<{ thread_id: string; message_id: string }> };

const Body = z.strictObject({ hidden_from_chat: z.boolean() });

export async function PATCH(req: NextRequest, { params }: Params) {
  const { thread_id, message_id } = await params;
  const body = await validateBody(req, Body);
  if (body instanceof NextResponse) return body;
  const updated = setMessageHiddenFromChat(thread_id, message_id, body.hidden_from_chat);
  if (!updated) return errorResponse(NOT_FOUND_ERRORS.MESSAGE_IN_THREAD, 404);
  return NextResponse.json({ updated: true });
}
