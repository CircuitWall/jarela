import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import {
  getOrCreateAgentThread,
  getMessages,
  getThread,
  pruneThreadMessages,
  setThreadContextPin,
  setThreadWarmSummary,
} from "@/lib/stores/threads";
import { getModelConfig, getDefaultModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import { putMemory, listMemory, deleteMemory } from "@/lib/stores/memory";
import type { ProviderParams } from "@/lib/providers/types";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";

type Params = { params: Promise<{ id: string }> };

// Upper bound on retained messages per thread. After /compact persists the
// summary we trim the oldest rows so a long-lived thread doesn't grow
// without limit. Override via JARELA_MAX_THREAD_MESSAGES.
function maxThreadMessages(): number {
  const raw = process.env.JARELA_MAX_THREAD_MESSAGES;
  if (!raw) return 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

// Upper bound on archived session summaries per agent. Each /compact writes a
// row to memory namespace `sessions` keyed `${agentId}/${ts}`; without a cap
// these grow unbounded (~summary text + embedding per row). Override via
// JARELA_MAX_SESSION_ARCHIVES.
function maxSessionArchives(): number {
  const raw = process.env.JARELA_MAX_SESSION_ARCHIVES;
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// Drop oldest `sessions/${agentId}/*` entries past the retention cap.
// Returns the number of rows actually removed.
function pruneSessionArchives(agentId: string, keepLast: number): number {
  // listMemory's `search` is a substring LIKE against key+value — that would
  // catch unrelated rows whose value happened to contain the agent id, so we
  // pull the namespace and filter by key prefix in code instead.
  const prefix = `${agentId}/`;
  const all = listMemory("sessions", undefined, 10_000)
    .filter((r) => r.key.startsWith(prefix))
    .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
  if (all.length <= keepLast) return 0;
  const drop = all.slice(0, all.length - keepLast);
  let removed = 0;
  for (const row of drop) {
    if (deleteMemory("sessions", row.key)) removed++;
  }
  return removed;
}

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const agent = getAgentConfig(id);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const thread = getOrCreateAgentThread(id);
  const rows = getMessages(thread.thread_id);

  if (rows.length < 2) {
    return NextResponse.json({ compacted: false, reason: "nothing to compact" });
  }

  // Resolve model config
  const cfg = agent.model_config_name
    ? getModelConfig(agent.model_config_name)
    : getDefaultModelConfig();

  if (!cfg) {
    return NextResponse.json({ error: "No model configured" }, { status: 400 });
  }

  const providerParams: ProviderParams = getModelParams(cfg);

  // Build transcript (text-flattened so base64 image data doesn't poison the
  // summarization prompt) BEFORE touching the thread. If anything below fails
  // we don't want to have already wiped the user's history.
  const flattened = rows.map((r) => ({
    role: r.role,
    text: transcriptText(r.content),
  }));
  const transcript = flattened
    .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.text}`)
    .join("\n\n");
  const contextChars = transcript.length;
  const messageCount = rows.length;

  const provider = getProvider(cfg.provider);

  // Summarize FIRST. Only move the boundary / persist anything once we have a
  // summary safely in hand — a model failure must leave the thread untouched.
  let summary = "";
  try {
    summary = await summarizeTranscript(provider, cfg.model_id, providerParams, transcript);
  } catch (err) {
    return NextResponse.json(
      { error: `Summarization failed: ${String(err)}`, code: "summarize_failed" },
      { status: 502 },
    );
  }

  summary = summary.trim();

  // Long-term archive (independent of the live thread).
  putMemory("sessions", `${id}/${Date.now()}`, {
    summary,
    agent_id: id,
    agent_name: agent.name,
    message_count: messageCount,
    compacted_at: new Date().toISOString(),
  });
  const archivePruned = pruneSessionArchives(id, maxSessionArchives());

  // Move the hot/warm boundary to a timestamp strictly greater than the last
  // existing message so every loaded turn becomes "warm" and the next user
  // turn is the first hot message. Pin to last_created_at + 1ms so the
  // divider reliably renders below the last bubble even if the user fires
  // their next message in the same millisecond.
  const lastCreatedAt = rows[rows.length - 1].created_at;
  const lastMs = Date.parse(lastCreatedAt);
  const pinMs = Number.isFinite(lastMs) ? lastMs + 1 : Date.now();
  const newPin = new Date(pinMs).toISOString();

  setThreadContextPin(thread.thread_id, newPin);
  setThreadWarmSummary(thread.thread_id, summary, newPin);

  // Retention: cap the persisted transcript. Older messages above the cap
  // are unrecoverable from the chat UI but their content lives on inside
  // the warm summary + the `sessions` memory entry above.
  const pruned = pruneThreadMessages(thread.thread_id, maxThreadMessages());

  const updated = getThread(thread.thread_id);

  return NextResponse.json({
    compacted: true,
    summary,
    message_count: messageCount,
    context_chars: contextChars,
    pruned,
    archive_pruned: archivePruned,
    hot_since: updated?.hot_since ?? newPin,
    warm_summary: updated?.warm_summary ?? summary,
    warm_summary_before: updated?.warm_summary_before ?? newPin,
    warm_summary_computed_at: updated?.warm_summary_computed_at ?? null,
  });
}
