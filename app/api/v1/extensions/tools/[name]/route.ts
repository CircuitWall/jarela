// PATCH /api/v1/extensions/tools/:name
//
// Toggle the enabled state of a drop-in (.cjs) tool. Disabled tools are
// excluded from the agent's tool pool and will throw if directly invoked.
//
// Body: { enabled: boolean }

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadExternalTools } from "@/lib/tools/external";
import { getBuiltinToolNames } from "@/lib/tools";
import {
  isDropinDisabled,
  setDropinDisabled,
} from "@/lib/stores/disabled-dropin-tools";

const BodySchema = z.object({
  enabled: z.boolean(),
});

export async function PATCH(
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
  if (!tools.files.has(name)) {
    return NextResponse.json({ error: "tool not found" }, { status: 404 });
  }

  setDropinDisabled(name, !body.enabled);

  return NextResponse.json({ name, enabled: !isDropinDisabled(name) });
}
