import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread, getMessages, clearThreadMessages } from "@/lib/stores/threads";
import { getModelConfig, getDefaultModelConfig, getModelParams } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import { putMemory } from "@/lib/stores/memory";
import type { ProviderParams } from "@/lib/providers/types";
import { summarizeTranscript, transcriptText } from "@/lib/agents/conversation-summary";

type Params = { params: Promise<{ id: string }> };

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

  // Summarize FIRST. Only clear messages once we have a summary safely
  // persisted to memory — otherwise a model failure would lose history with
  // no recovery path.
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

  putMemory("sessions", `${id}/${Date.now()}`, {
    summary,
    agent_id: id,
    agent_name: agent.name,
    message_count: messageCount,
    compacted_at: new Date().toISOString(),
  });

  clearThreadMessages(thread.thread_id);

  return NextResponse.json({
    compacted: true,
    summary,
    message_count: messageCount,
    context_chars: contextChars,
  });
}
