import { NextResponse } from "next/server";
import { INTEGRATIONS, listIntegrations, DYNAMIC_INTEGRATIONS_SNAPSHOT } from "@/lib/stores/integrations";
import { refreshExternalProviderIntegrations } from "@/lib/providers/provider-integrations";

// GET /api/v1/integrations
// Returns a list of supported integrations with their schema (so the UI can
// render a generic form) plus current saved values (secrets masked).
// Drop-in providers that declare `credentials` appear alongside native ones.
export function GET() {
  refreshExternalProviderIntegrations();

  const staticDefs = Object.entries(INTEGRATIONS).map(([name, def]) => ({
    name,
    label: def.label,
    description: def.description,
    fields: def.fields,
    category: def.category,
  }));
  const dynamicDefs = DYNAMIC_INTEGRATIONS_SNAPSHOT().map(([name, def]) => ({
    name,
    label: def.label,
    description: def.description,
    fields: def.fields,
    category: def.category,
  }));

  const statuses = listIntegrations();
  return NextResponse.json({ definitions: [...staticDefs, ...dynamicDefs], statuses });
}
