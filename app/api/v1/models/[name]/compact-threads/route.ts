/**
 * @public — `POST /api/v1/models/[name]/compact-threads`
 *
 * Used when an operator is about to swap a model config to one with a
 * smaller context window. Iterates every thread owned by an agent that
 * binds this model_config (or every thread, if `name` is the workspace
 * default and other agents fall back to it) and produces a warm summary
 * using the **caller-supplied provider snapshot** (the OLD model). This
 * lets the swap complete safely: the next turn on the smaller model
 * reuses the cached summary instead of re-summarising on the spot,
 * which would fail under the new tight budget.
 *
 * Body: { using: { provider, model_id, params }, keep_last?: number }
 *   - `using` is the OLD provider snapshot (not read from DB so the
 *     endpoint works both before and after the actual upsert).
 *   - `keep_last` controls how many trailing messages stay in the hot
 *     tier; everything older gets folded into the warm summary.
 *     Defaults to 8.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listAgentConfigs } from "@/lib/stores/agent-configs";
import { getDefaultModelConfig } from "@/lib/stores/model-config";
import { listThreadsByAgent, getMessages, setThreadWarmSummary } from "@/lib/stores/threads";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";
import { getProvider } from "@/lib/providers";
import type { ProviderParams } from "@/lib/providers/types";
import { errorMessage } from "@/lib/utils/error";

type Params = { params: Promise<{ name: string }> };

const Body = z.object({
  using: z.object({
    provider: z.string().min(1),
    model_id: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  keep_last: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: NextRequest, { params }: Params) {
  const { name } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message, code: "invalid_body" }, { status: 400 });
  }
  const { using, keep_last = 8 } = parsed.data;

  let provider;
  try { provider = getProvider(using.provider); }
  catch (e) { return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 }); }

  // Agents that explicitly bind this model_config. If the model is the
  // workspace default, agents with model_config_name === null also fall
  // back to it and need their warm summaries covered too.
  const defaultModel = getDefaultModelConfig();
  const isDefault = defaultModel?.name === name;
  const agents = listAgentConfigs().filter((a) =>
    a.model_config_name === name || (isDefault && !a.model_config_name),
  );

  let compacted = 0;
  let skipped = 0;
  const errors: Array<{ thread_id: string; error: string }> = [];

  for (const agent of agents) {
    const threads = listThreadsByAgent(agent.id, 200);
    for (const t of threads) {
      const msgs = getMessages(t.thread_id);
      if (msgs.length <= keep_last) { skipped += 1; continue; }
      const warmMsgs = msgs.slice(0, msgs.length - keep_last);
      const hotStart = msgs[msgs.length - keep_last]!;
      const transcript = warmMsgs
        .map((m) => `${m.role}: ${transcriptText(m.content)}`)
        .join("\n");
      try {
        const summary = await summarizeTranscript(
          provider,
          using.model_id,
          (using.params ?? {}) as ProviderParams,
          transcript,
        );
        if (summary) {
          setThreadWarmSummary(t.thread_id, summary, hotStart.created_at);
          compacted += 1;
        } else {
          skipped += 1;
        }
      } catch (e) {
        errors.push({ thread_id: t.thread_id, error: errorMessage(e) });
      }
    }
  }

  return NextResponse.json({ compacted, skipped, errors });
}
