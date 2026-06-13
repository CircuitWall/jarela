// Env-overrides REST surface — backs the EnvVarsPanel UI and the
// set_env_var agent tool.
//
//   GET    /api/v1/env       — schema + current value + override + tier per var
//   PATCH  /api/v1/env       — set or unset a single override (body: {name, value|null})
//   DELETE /api/v1/env?name= — clear a single override (alias for PATCH null)
//
// All gated by the same loopback / auth rules as the rest of /api/v1.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { envSchemaList, envSchemaByName } from "@/lib/env/schema";
import { readOverrides, patchOverride, validateForSchema } from "@/lib/env/overrides";
import { resetConfigCache } from "@/lib/env/config";
import { errorResponse, validateBody } from "@/lib/api/responses";

const PatchBody = z.object({
  name: z.string().min(1, "name required"),
  value: z.union([z.string(), z.null()]),
});

interface EnvRowDTO {
  name: string;
  type: "int" | "string" | "bool" | "enum";
  default: number | string | boolean;
  current: string;
  /** True when the user has set a persistent override that's currently active. */
  overridden: boolean;
  description: string;
  category: string;
  tier: "A" | "B" | "C";
  requiresRestart: boolean;
  agentWritable: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
}

export async function GET(): Promise<Response> {
  const overrides = await readOverrides();
  const rows: EnvRowDTO[] = envSchemaList().map((def) => {
    const live = process.env[def.name];
    const current = live !== undefined && live !== "" ? live : String(def.default);
    return {
      name: def.name,
      type: def.type,
      default: def.default,
      current,
      overridden: Object.prototype.hasOwnProperty.call(overrides.entries, def.name),
      description: def.description,
      category: def.category,
      tier: def.tier,
      requiresRestart: def.requiresRestart,
      agentWritable: def.agentWritable,
      enumValues: def.enumValues,
      min: def.min,
      max: def.max,
    };
  });
  return NextResponse.json({ entries: rows });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const body = await validateBody(req, PatchBody);
  if (body instanceof NextResponse) return body;
  const { name, value } = body;
  const def = envSchemaByName().get(name);
  if (!def) return errorResponse(`unknown env var: ${name}`, 400);
  if (value !== null) {
    const verr = validateForSchema(def, value);
    if (verr) return errorResponse(`${name}: ${verr}`, 400);
  }
  await patchOverride(name, value);
  // Mutate live process.env so non-restart vars hot-apply on the next read,
  // then drop the config cache so getConfig() rebuilds on demand.
  if (value === null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  resetConfigCache();
  return NextResponse.json({
    ok: true,
    name,
    value,
    requiresRestart: def.requiresRestart,
  });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return errorResponse("name query param required");
  const def = envSchemaByName().get(name);
  if (!def) return errorResponse(`unknown env var: ${name}`, 400);
  await patchOverride(name, null);
  delete process.env[name];
  resetConfigCache();
  return NextResponse.json({ ok: true, name, requiresRestart: def.requiresRestart });
}
