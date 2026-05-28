// Allowlist API for env-sync overrides.
//
// GET  → defaults (code-owned ENV_ALLOWLIST) plus the user's stored
//        per-(integration, field) env-var aliases.
// PUT  → upsert one override row. Empty `envVars` removes it.
//
// Targets are constrained: integration + field must already exist in
// INTEGRATIONS. Users can only add env-var name aliases for an existing
// schema entry — see ADR-0034 for the rationale.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ENV_ALLOWLIST, listOverrides, setOverride } from "@/lib/env/allowlist";

const PutSchema = z.object({
  integration: z.string().min(1),
  field: z.string().min(1),
  envVars: z.array(z.string()),
});

function snapshot() {
  return {
    defaults: ENV_ALLOWLIST.map((m) => ({ envVars: [...m.envVars], integration: m.integration, field: m.field })),
    overrides: listOverrides(),
  };
}

export function GET() {
  return NextResponse.json(snapshot());
}

export async function PUT(req: NextRequest) {
  const parsed = PutSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { integration, field, envVars } = parsed.data;
  const result = setOverride(integration, field, envVars);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(snapshot());
}
