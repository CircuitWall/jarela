import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getAgentConfig,
  getAgentDisplayFilters,
  updateAgentDisplayFilters,
  DISPLAY_FILTER_KEYS,
  DISPLAY_FILTER_DEFAULTS,
} from "@/lib/stores/agent-configs";
import { notFoundResponse, validateBody } from "@/lib/api/responses";

// ADR-0022: per-agent message-channel display filters.
// GET  -> { filters: DisplayFilters, defaults: DisplayFilters }
// PUT  -> body: { filters: Partial<DisplayFilters> | null }
//         (null resets to defaults; partial map merges server-side)

type Params = { params: Promise<{ id: string }> };

const BoolMap = z.object(
  Object.fromEntries(DISPLAY_FILTER_KEYS.map((k) => [k, z.boolean().optional()])),
).strict();

const PutSchema = z.object({
  filters: z.union([BoolMap, z.null()]),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getAgentConfig(id)) return notFoundResponse("Agent not found");
  const filters = getAgentDisplayFilters(id) ?? DISPLAY_FILTER_DEFAULTS;
  return NextResponse.json({ filters, defaults: DISPLAY_FILTER_DEFAULTS });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getAgentConfig(id)) return notFoundResponse("Agent not found");
  const parsed = await validateBody(req, PutSchema);
  if (parsed instanceof NextResponse) return parsed;
  const next = updateAgentDisplayFilters(id, parsed.filters);
  return NextResponse.json({ filters: next, defaults: DISPLAY_FILTER_DEFAULTS });
}
