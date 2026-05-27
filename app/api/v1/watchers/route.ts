import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createWatcher, listWatchers, type WatcherRow } from "@/lib/stores/watchers";
import { registeredTools } from "@/lib/tools/registry";
import { startScheduler } from "@/lib/scheduler";

function rowResponse(r: WatcherRow) {
  let args: unknown;
  try { args = JSON.parse(r.tool_args); } catch { args = {}; }
  let scriptArgs: unknown = null;
  if (r.reaction_script_args) {
    try { scriptArgs = JSON.parse(r.reaction_script_args); }
    catch { scriptArgs = null; }
  }
  return {
    id: r.id,
    agent_id: r.agent_id,
    label: r.label,
    tool: r.tool_name,
    args,
    interval_seconds: r.interval_seconds,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    last_fired_at: r.last_fired_at,
    last_error: r.last_error,
    enabled: r.enabled === 1,
    silent: r.silent === 1,
    reaction_kind: r.reaction_kind,
    reaction_prompt: r.reaction_prompt,
    reaction_script: r.reaction_script,
    reaction_script_args: scriptArgs,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agent_id = url.searchParams.get("agent_id") ?? undefined;
  return NextResponse.json(listWatchers(agent_id).map(rowResponse));
}

const CreateSchema = z.object({
  agent_id: z.string().min(1),
  label: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  every_seconds: z.number().int().min(60),
  silent: z.boolean().optional(),
  // ADR-0030: optional user-supplied directive used when the diff fires.
  reaction_prompt: z.string().max(4000).optional(),
  // ADR-0031: discriminated reaction. When kind='script', reaction_script
  // is required; reaction_script_args is forwarded to the script.
  reaction_kind: z.enum(["agent_prompt", "script"]).optional(),
  reaction_script: z.string().optional(),
  reaction_script_args: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }
  const {
    agent_id,
    label,
    tool,
    args,
    every_seconds,
    silent,
    reaction_prompt,
    reaction_kind,
    reaction_script,
    reaction_script_args,
  } = parsed.data;
  const exists = registeredTools().find((t) => t.name === tool);
  if (!exists) {
    return NextResponse.json({ error: `tool "${tool}" is not a built-in tool` }, { status: 400 });
  }
  try {
    const row = createWatcher({
      agent_id,
      label,
      tool_name: tool,
      tool_args: args ?? {},
      interval_seconds: every_seconds,
      silent,
      reaction_kind,
      reaction_prompt,
      reaction_script,
      reaction_script_args,
    });
    startScheduler();
    return NextResponse.json(rowResponse(row), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
