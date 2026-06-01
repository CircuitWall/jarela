import { NextRequest, NextResponse } from "next/server";
import {
  deleteThread,
  getMessagesAfter,
  getMessagesPage,
  getThread,
  type MessageRow,
} from "@/lib/stores/threads";
import { getMessageUsageByIds } from "@/lib/stores/message-usage";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { getModelConfig, getModelParams } from "@/lib/stores/model-config";

type Params = { params: Promise<{ thread_id: string }> };

const DEFAULT_PAGE = 50;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;

export async function GET(req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const thread = getThread(thread_id);
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || DEFAULT_PAGE));
  const before = url.searchParams.get("before") ?? undefined;
  const after  = url.searchParams.get("after")  ?? undefined;

  // `after` is a forward-fetch shortcut: caller (typically ChatView's
  // run-completion handler) already has the recent messages and just wants
  // the freshly-persisted ones. has_more is fixed to false because the
  // forward window is not paginated — caller already has everything older.
  let messages: MessageRow[];
  let has_more: boolean;
  if (after) {
    messages = getMessagesAfter(thread_id, after, limit);
    has_more = false;
  } else {
    const page = getMessagesPage(thread_id, limit, before);
    messages = page.messages;
    has_more = page.has_more;
  }

  // Attach per-assistant-turn usage so the chat UI can render a context
  // utilisation bar without an extra round-trip per message. User turns
  // and legacy assistant rows (pre-message_usage table) simply omit the
  // field.
  const assistantIds = messages.filter((m) => m.role === "assistant").map((m) => m.msg_id);
  const usageById = getMessageUsageByIds(assistantIds);

  // Resolve the agent's effective context-window size once for the whole
  // thread. The bar scales against this cap so the visual matches the
  // budget the agent applies at run time.
  const agentCfg = getAgentConfig(thread.agent_id);
  const modelCfg = agentCfg?.model_config_name ? getModelConfig(agentCfg.model_config_name) : null;
  const modelParams = modelCfg ? getModelParams(modelCfg) : null;
  const cwRaw = modelParams?.context_window_tokens;
  const contextWindowTokens =
    typeof cwRaw === "number" && cwRaw > 0 ? cwRaw : DEFAULT_CONTEXT_WINDOW_TOKENS;

  return NextResponse.json({
    ...thread,
    context_window_tokens: contextWindowTokens,
    // No server-side filtering: clients receive every message with its
    // `category` tag and apply the chat-panel filter toolbar on the
    // render side. Keeping the raw transcript over the wire means audit
    // history is reachable from any client without round-trip params.
    messages: messages.map((m) => {
      const u = usageById.get(m.msg_id);
      return {
        id: m.msg_id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
        tool_events: parseToolEvents(m.tool_events),
        category: m.category ?? null,
        usage: u
          ? {
              input_tokens: u.input_tokens,
              output_tokens: u.output_tokens,
              hot_tokens: u.hot_tokens,
              warm_tokens: u.warm_tokens,
              facts_tokens: u.facts_tokens,
              overhead_tokens: u.overhead_tokens,
              hot_budget_tokens: u.hot_budget_tokens,
              warm_budget_tokens: u.warm_budget_tokens,
              facts_budget_tokens: u.facts_budget_tokens,
              context_window_tokens: u.context_window_tokens,
            }
          : null,
      };
    }),
    has_more,
  });
}

function parseToolEvents(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { thread_id } = await params;
  const deleted = deleteThread(thread_id);
  if (!deleted) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
