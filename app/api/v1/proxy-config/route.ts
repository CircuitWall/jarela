import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteProxyConfig,
  getProxyConfigStatus,
  saveProxyConfig,
} from "@/lib/stores/proxy-config";
import { applyProxyConfigFromDb, envProxyWasSetAtBoot } from "@/lib/proxy/dispatcher";

// Single-row proxy config (ADR-0009). GET returns current status; PUT
// upserts; DELETE clears.
//
// Save & delete both call applyProxyConfigFromDb() so the change takes
// effect on the *next* outbound request without a server restart. See
// ADR-0009 "Live-swap caveats" for the narrow exceptions.

const InputSchema = z.object({
  mode: z.enum(["off", "manual", "system"]),
  scheme: z.enum(["http", "https"]).optional().default("http"),
  host: z.string().nullish(),
  port: z.number().int().positive().max(65535).nullish(),
  username: z.string().nullish(),
  password: z.string().nullish(),
  no_proxy: z.string().nullish(),
  ca_bundle: z.string().nullish(),
});

export function GET() {
  return NextResponse.json({
    config: getProxyConfigStatus(),
    env_override: envProxyWasSetAtBoot(),
  });
}

export async function PUT(req: NextRequest) {
  const parsed = InputSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const result = saveProxyConfig(parsed.data);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  const apply = await applyProxyConfigFromDb();
  return NextResponse.json({ config: result, applied: apply, env_override: envProxyWasSetAtBoot() });
}

export async function DELETE() {
  const removed = deleteProxyConfig();
  const apply = await applyProxyConfigFromDb();
  return NextResponse.json({ deleted: removed, applied: apply, env_override: envProxyWasSetAtBoot() });
}
