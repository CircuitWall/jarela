import { NextResponse } from "next/server";
import { INTEGRATIONS, listIntegrations } from "@/lib/stores/integrations";

// GET /api/v1/integrations
// Returns a list of supported integrations with their schema (so the UI can
// render a generic form) plus current saved values (secrets masked).
export function GET() {
  const definitions = Object.entries(INTEGRATIONS).map(([name, def]) => ({
    name,
    label: def.label,
    description: def.description,
    fields: def.fields,
  }));
  const statuses = listIntegrations();
  return NextResponse.json({ definitions, statuses });
}
