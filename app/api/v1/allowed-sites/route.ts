import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addAllowedSite,
  listAllowedSites,
} from "@/lib/stores/allowed-sites";
import { validateBody } from "@/lib/api/responses";

// Allowed-sites list. Each row is a host the user has approved the agent
// to use as them — granting both browser-RPC navigation and cookie
// passthrough. Hit by:
//   - the Settings UI (AllowedSitesSection)
//   - the browser extension on startup + heartbeat (cached locally so the
//     SW knows which onChanged events to relay)
//   - the in-browser approval popup's "Allow always" button (POST)
//
// GET returns the list (no cookie values). POST adds a host. Per-host
// cookie blob writes and removal live at /api/v1/allowed-sites/[hostname].

const AddInputSchema = z.object({
  hostname: z.string().min(1).max(253),
  ssrf_bypass: z.boolean().optional(),
});

export function GET() {
  return NextResponse.json({ sites: listAllowedSites() });
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, AddInputSchema);
  if (parsed instanceof NextResponse) return parsed;
  const result = addAllowedSite(parsed);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ site: result }, { status: 201 });
}
