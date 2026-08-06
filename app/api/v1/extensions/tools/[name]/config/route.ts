// GET/PUT /api/v1/extensions/tools/:name/config
//
// Read and persist configuration values for an external tool's declared config
// slots. Unlike the secrets route, values are stored unencrypted and returned
// as-is — config holds non-sensitive settings like base URLs or timeouts.
//
// An empty string in a PUT payload means "delete this slot's stored value" so
// the tool falls back to its declared default. Values are validated against the
// slots the tool itself declared to prevent storing arbitrary keys.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadExternalTools } from "@/lib/tools/external";
import { getBuiltinToolNames } from "@/lib/tools";
import {
  describeToolConfig,
  setToolConfig,
  deleteToolConfig,
} from "@/lib/stores/tool-config";

const BodySchema = z.object({
  values: z.record(z.string(), z.string()),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const tools = loadExternalTools(getBuiltinToolNames());
  const slots = tools.configs.get(name);
  if (!slots) {
    return NextResponse.json({ error: "tool not found" }, { status: 404 });
  }
  return NextResponse.json({
    name,
    config: describeToolConfig(name, slots),
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
  const slots = tools.configs.get(name);
  if (!slots) {
    return NextResponse.json({ error: "tool not found" }, { status: 404 });
  }
  const declaredKeys = new Set(slots.map((s) => s.key));

  for (const [key, value] of Object.entries(body.values)) {
    if (!declaredKeys.has(key)) {
      return NextResponse.json(
        { error: `tool "${name}" did not declare config slot "${key}"` },
        { status: 400 },
      );
    }
    if (value === "") {
      deleteToolConfig(name, key);
    } else {
      setToolConfig(name, key, value);
    }
  }

  return NextResponse.json({
    name,
    config: describeToolConfig(name, slots),
  });
}
