// PUT /api/v1/extensions/tools/:name/secrets
//
// Persist secret values for an external tool's declared secret slots
// (ADR-0023). Values are envelope-encrypted at rest via the `tool-secrets`
// memory namespace. The masked sentinel ("********") is treated as
// "leave unchanged" so the UI can echo back the masked form without
// blanking previously-saved values.
//
// We validate against the slots the tool itself declared in its
// `module.exports.secrets` to avoid persisting arbitrary attacker-supplied
// keys.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadExternalTools } from "@/lib/tools/external";
import { getBuiltinToolNames } from "@/lib/tools";
import {
  describeToolSecrets,
  setToolSecret,
  deleteToolSecret,
} from "@/lib/stores/tool-secrets";

const SECRET_MASK = "********";

const BodySchema = z.object({
  values: z.record(z.string(), z.string()),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const tools = loadExternalTools(getBuiltinToolNames());
  const slots = tools.secrets.get(name);
  if (!slots) {
    return NextResponse.json({ error: "tool not found" }, { status: 404 });
  }
  return NextResponse.json({
    name,
    secrets: describeToolSecrets(name, slots),
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid body", detail: String(err) },
      { status: 400 },
    );
  }

  const tools = loadExternalTools(getBuiltinToolNames());
  const slots = tools.secrets.get(name);
  if (!slots) {
    return NextResponse.json({ error: "tool not found" }, { status: 404 });
  }
  const declaredKeys = new Set(slots.map((s) => s.key));

  for (const [key, value] of Object.entries(body.values)) {
    if (!declaredKeys.has(key)) {
      return NextResponse.json(
        { error: `tool "${name}" did not declare secret slot "${key}"` },
        { status: 400 },
      );
    }
    if (value === SECRET_MASK) continue; // leave existing value untouched
    if (value === "") {
      deleteToolSecret(name, key);
    } else {
      setToolSecret(name, key, value);
    }
  }

  return NextResponse.json({
    name,
    secrets: describeToolSecrets(name, slots),
  });
}
