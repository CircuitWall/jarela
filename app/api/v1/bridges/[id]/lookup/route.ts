import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getBridge } from "@/lib/stores/bridges";
import { lookupBridgeChat } from "@/lib/bridges/runtime";

interface Params { params: Promise<{ id: string }> }

const Schema = z.object({
  /** Freeform phone number — country code + number, separators allowed. */
  phone: z.string().trim().min(3).max(40),
});

/**
 * Verify a phone number is on WhatsApp and return its routable JID.
 *
 * Wraps Baileys' `onWhatsApp()` call. Used by the route editor's "search"
 * UI so users can pin a DM that hasn't surfaced via history sync (Baileys
 * delivers only recent chats when `syncFullHistory` is off, which is our
 * default for cost/RAM reasons).
 *
 * 200 + `{ chat: null }` means the number isn't on WhatsApp — distinct
 * from a 404 (bridge not found) or 409 (bridge not connected).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getBridge(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
  }

  const chat = await lookupBridgeChat(id, parsed.data.phone);
  return NextResponse.json({ chat });
}
