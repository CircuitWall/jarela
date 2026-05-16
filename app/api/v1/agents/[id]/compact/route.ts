import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread, getMessages, clearThreadMessages } from "@/lib/stores/threads";
import { getModelConfig, getDefaultModelConfig } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import { putMemory } from "@/lib/stores/memory";
import type { ProviderParams } from "@/lib/providers/types";
import type { ContentPart } from "@/lib/tools/types";

type Params = { params: Promise<{ id: string }> };

// Messages with attachments are stored as a JSON-stringified ContentPart[]
// (text + image/file parts whose `data` is base64). Feeding that raw into
// the summarizer dumps multi-MB base64 blobs into the prompt and blows the
// context window. For compaction we only need the textual narrative; replace
// image/file parts with short stubs so the summary still mentions them.
function transcriptText(raw: string): string {
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return raw;
    return (parsed as ContentPart[])
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "image") return `[image attachment: ${p.media_type}]`;
        if (p.type === "file") return `[file attachment: ${p.name} (${p.media_type})]`;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  } catch {
    return raw;
  }
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

  let providerParams: ProviderParams;
  try {
    providerParams = JSON.parse(cfg.params) as ProviderParams;
  } catch {
    return NextResponse.json({ error: "Invalid model params" }, { status: 500 });
  }

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
  const summaryMessages = [
    {
      role: "system" as const,
      content: "You are a concise summarizer. Summarize the conversation below in 3-7 bullet points, capturing key facts, decisions, and context that would be useful to remember later.",
    },
    {
      role: "user" as const,
      content: `Conversation to summarize:\n\n${transcript}`,
    },
  ];

  // Summarize FIRST. Only clear messages once we have a summary safely
  // persisted to memory — otherwise a model failure would lose history with
  // no recovery path.
  let summary = "";
  try {
    const { stream } = await provider.chat(cfg.model_id, summaryMessages, providerParams);
    for await (const chunk of stream) {
      summary += chunk;
    }
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
