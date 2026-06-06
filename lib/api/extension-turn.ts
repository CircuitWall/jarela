import { z } from "zod";
import { createThread, listThreadsByAgent, type ThreadRow } from "@/lib/stores/threads";
import { getAgentConfig, getDefaultAgentConfig, listAgentConfigs, type AgentConfigRow } from "@/lib/stores/agent-configs";
import { runAgentTurn } from "@/lib/agents/agent-turn";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { composePrompt, ExtensionActionEnum } from "./extension-turn-prompt";

export const ExtensionAction = ExtensionActionEnum;

const Body = z.object({
  instruction: z.string().trim().min(1).max(2000),
  text: z.string().max(120_000).optional(),
  url: z.string().url().optional(),
  title: z.string().max(500).optional(),
  selector: z.string().max(2000).optional(),
  page_context: z.string().max(30_000).optional(),
  agent_id: z.string().trim().min(1).max(200).optional(),
});

const GenericBody = Body.extend({
  action: ExtensionAction,
});

// Per-action thread strategy + display title. Surfaced here so the
// behaviour of each extension turn type is configured in one obvious
// place instead of being buried inside `pickThread` branches.
//
// - "isolated"     → spin a brand-new thread per call. Use for one-shot
//                    tools where prior chat history would contaminate
//                    the answer (fill, rewrite_clipboard).
// - "reuse_latest" → land on the agent's most recent thread so the user
//                    can keep iterating in the chat window
//                    ("make that more concise", "now translate it").
//                    Used for refine.
//
// To change behaviour for an action type, edit ONLY this map.
type ThreadStrategy = "isolated" | "reuse_latest";
const ACTION_THREAD_STRATEGY: Record<z.infer<typeof ExtensionAction>, { strategy: ThreadStrategy; isolatedTitle: string }> = {
  fill:              { strategy: "isolated",     isolatedTitle: "Fill focused field" },
  rewrite_clipboard: { strategy: "isolated",     isolatedTitle: "Rewrite to clipboard" },
  refine:            { strategy: "reuse_latest", isolatedTitle: "Refine selection" },
};

interface PickResult {
  thread_id: string;
  agent_id: string;
  agent_name: string;
  agent_icon_key: "blue" | "white" | null;
  thread_title: string | null;
  created: boolean;
}

function normalizeAgentIconKey(raw: string | null | undefined): "blue" | "white" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v.startsWith("bundle:")) {
    const k = v.slice("bundle:".length).trim();
    if (k === "blue" || k === "white") return k;
    return null;
  }
  if (v === "blue" || v === "white") return v;
  return null;
}

function pickThread(action: z.infer<typeof ExtensionAction>, agentId?: string): PickResult | { error: "no-agent" } {
  const requested: AgentConfigRow | null = agentId ? getAgentConfig(agentId) : null;
  const def: AgentConfigRow | null = getDefaultAgentConfig();
  const agent: AgentConfigRow | null = requested ?? def ?? listAgentConfigs()[0] ?? null;
  if (!agent) return { error: "no-agent" };

  const config = ACTION_THREAD_STRATEGY[action];

  if (config.strategy === "isolated") {
    const t = createThread(agent.id, config.isolatedTitle);
    return {
      thread_id: t.thread_id,
      agent_id: agent.id,
      agent_name: agent.name,
      agent_icon_key: normalizeAgentIconKey(agent.icon),
      thread_title: t.title,
      created: true,
    };
  }

  // reuse_latest — fall through to the most recent thread for the agent,
  // creating a long-lived "Extension turns" thread if there isn't one yet.
  const recent: ThreadRow[] = listThreadsByAgent(agent.id, 1);
  if (recent.length > 0) {
    return {
      thread_id: recent[0].thread_id,
      agent_id: agent.id,
      agent_name: agent.name,
      agent_icon_key: normalizeAgentIconKey(agent.icon),
      thread_title: recent[0].title,
      created: false,
    };
  }
  const t = createThread(agent.id, "Extension turns");
  return {
    thread_id: t.thread_id,
    agent_id: agent.id,
    agent_name: agent.name,
    agent_icon_key: normalizeAgentIconKey(agent.icon),
    thread_title: t.title,
    created: true,
  };
}

async function runExtensionAction(action: z.infer<typeof ExtensionAction>, input: z.infer<typeof Body>): Promise<Response> {
  const picked = pickThread(action, input.agent_id);
  if ("error" in picked) {
    return new Response(JSON.stringify({ error: "no agent configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const prompt = composePrompt(action, input);
  const run = await runAgentTurn({
    thread_id: picked.thread_id,
    queue_source: "extension",
    message: prompt,
    user_category: "extension",
    assistant_category: "extension",
  });

  // Ping the events bus so any open chat view on this thread re-fetches.
  // Same mechanism page-capture uses — without this the HTTP chat window
  // only updates after the next manual refresh.
  publishNotification({
    type: "thread_message_added",
    thread_id: picked.thread_id,
    agent_id: picked.agent_id,
    source: "extension",
    ts: Date.now(),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      action,
      thread_id: picked.thread_id,
      agent_id: picked.agent_id,
      agent_name: picked.agent_name,
      agent_icon_key: picked.agent_icon_key,
      thread_title: picked.thread_title,
      created_thread: picked.created,
      assistant: run.assistantContent,
      preview: run.preview,
      skipped_assistant: run.skippedAssistant,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function handleExtensionTurn(action: "refine" | "fill", req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Request body must be valid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.issues[0]?.message ?? "invalid body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  return runExtensionAction(action, parsed.data);
}

export async function handleGenericExtensionTurn(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Request body must be valid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const parsed = GenericBody.safeParse(raw);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.issues[0]?.message ?? "invalid body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  return runExtensionAction(parsed.data.action, parsed.data);
}

export async function handleExtensionAgents(): Promise<Response> {
  const all = listAgentConfigs();
  const def = getDefaultAgentConfig();
  return new Response(
    JSON.stringify({
      ok: true,
      default_agent_id: def?.id ?? null,
      agents: all.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        icon_key: normalizeAgentIconKey(a.icon),
        is_default: a.is_default === 1,
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
