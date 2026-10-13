import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBridge } from "@/lib/stores/bridges";
import { lookupBridgeChat } from "@/lib/bridges/runtime";
import { validateBody } from "@/lib/api/responses";

interface Params { params: Promise<{ id: string }> }

const Schema = z.object({
  input: z.string().trim().min(1).max(160).optional(),
  /** @deprecated Use `input`; retained for existing WhatsApp clients. */
  phone: z.string().trim().min(3).max(40).optional(),
}).refine((value) => Boolean(value.input || value.phone), "input is required");

/**
 * Resolve a channel-specific identifier to a chat on the selected bridge.
 *
 * 200 + `{ chat: null }` means no matching chat exists — distinct
 * from a 404 (bridge not found) or 409 (bridge not connected).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = await validateBody(req, Schema);
  if (parsed instanceof NextResponse) return parsed;

  const chat = await lookupBridgeChat(id, parsed.input ?? parsed.phone!);
  return NextResponse.json({ chat });
}
