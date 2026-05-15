import { NextResponse } from "next/server";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getOrCreateAgentThread, getMessages, clearThreadMessages } from "@/lib/stores/threads";
import { getModelConfig, getDefaultModelConfig } from "@/lib/stores/model-config";
import { getProvider } from "@/lib/providers";
import { putMemory } from "@/lib/stores/memory";
import type { ProviderParams } from "@/lib/providers/types";

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

  let providerParams: ProviderParams;
  try {
    providerParams = JSON.parse(cfg.params) as ProviderParams;
  } catch {
    return NextResponse.json({ error: "Invalid model params" }, { status: 500 });
  }

  const provider = getProvider(cfg.provider);

  // Build conversation transcript for summarization
  const transcript = rows
    .map((r) => `${r.role === "user" ? "User" : "Assistant"}: ${r.content}`)
    .join("\n\n");

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

  let summary = "";
  try {
    const { stream } = await provider.chat(cfg.model_id, summaryMessages, providerParams);
    for await (const chunk of stream) {
      summary += chunk;
    }
  } catch (err) {
    return NextResponse.json({ error: `Summarization failed: ${String(err)}` }, { status: 500 });
  }

  summary = summary.trim();

  // Save to shared memory under "sessions" namespace
  putMemory("sessions", `${id}/${Date.now()}`, {
    summary,
    agent_id: id,
    agent_name: agent.name,
    message_count: rows.length,
    compacted_at: new Date().toISOString(),
  });

  clearThreadMessages(thread.thread_id);

  return NextResponse.json({ compacted: true, summary });
}
