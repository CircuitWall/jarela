import { getOrCreateAgentThread, type PersistedToolEvent } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { resolveRoute } from "./router";
import type { BridgeAdapter, InboundMessage } from "./types";

/**
 * Handle one inbound message from a bridge adapter:
 *   1. Resolve the chat → agent route. Unrouted → publish an advisory
 *      event and drop. No thread created, no reply sent.
 *   2. Use `getOrCreateAgentThread(agent_id)` (one-thread-per-agent
 *      invariant — `UNIQUE(agent_id)` on bridge_routes ensures no chat
 *      interleaving).
 *   3. Drive the agent via `prepareThreadRun` and drain the stream just
 *      like the scheduler does in lib/scheduler/index.ts.
 *   4. Persist the assistant message and send the reply back through the
 *      adapter on the originating channel.
 *
 * Top-level try/catch — adapter callbacks must never throw into the Baileys
 * socket event handler (would tear down the WS).
 */
export async function handleInboundMessage(
  adapter: BridgeAdapter,
  msg: InboundMessage,
): Promise<void> {
  try {
    const route = resolveRoute(adapter.bridge_id, msg.remote_jid);
    if (!route) {
      // Unrouted chats are silently dropped. We intentionally do NOT publish
      // a notification here — the user already declared "this chat isn't
      // monitored" by not configuring a route, so popping a toast for every
      // inbound message in an active group would be noise. The console log
      // remains for debugging; the chat picker in BridgeEditor still shows
      // observed chats so a route can be added on demand.
      console.log(`[bridge ${adapter.bridge_id}] dropped: no route for ${msg.remote_jid} (${msg.push_name ?? "?"})`);
      return;
    }
    const agentId = route.agent_id;

    const agent = getAgentConfig(agentId);
    if (!agent) {
      console.warn(`[bridge ${adapter.bridge_id}] route points at missing agent ${agentId}, dropping`);
      return;
    }

    const thread = getOrCreateAgentThread(agentId);
    // For group chats, prepend a sender attribution line so the agent can
    // tell members apart — the single-thread-per-agent invariant means every
    // participant's messages land in the same thread. For DMs we leave the
    // text untouched (the thread itself implies the sender).
    const senderTag = msg.is_group
      ? `[from ${msg.push_name ?? msg.participant_jid ?? "unknown"}]\n`
      : "";
    const prepared = await prepareThreadRun(thread.thread_id, senderTag + msg.text);

    // Show the "composing…" presence on the channel while we drain the
    // LLM stream. Refresh every ~8s because WhatsApp drops the indicator
    // after ~10s if not renewed. We always send a final "paused" in the
    // finally block, regardless of success/throw, so we never leave a
    // stuck typing indicator.
    let typingActive = true;
    void adapter.sendTyping(msg.remote_jid, true).catch(() => { /* best-effort */ });
    const typingTimer = setInterval(() => {
      if (!typingActive) return;
      void adapter.sendTyping(msg.remote_jid, true).catch(() => { /* best-effort */ });
    }, 8_000);
    (typingTimer as unknown as { unref?: () => void }).unref?.();

    let assistantContent = "";
    const usedTools: string[] = [];
    const toolEvents: PersistedToolEvent[] = [];
    try {
      for await (const chunk of prepared.stream) {
        if (chunk.type === "text_delta") {
          assistantContent += (chunk.data.delta as string) ?? "";
        } else if (chunk.type === "tool_call") {
          const d = chunk.data as { id?: string; name?: string; arguments?: unknown };
          if (d.name) usedTools.push(d.name);
          toolEvents.push({
            id: d.id ?? `call-${toolEvents.length}`,
            phase: "call",
            name: d.name ?? "",
            payload: d.arguments,
          });
        } else if (chunk.type === "tool_result") {
          const d = chunk.data as { id?: string; name?: string; result?: unknown };
          toolEvents.push({
            id: d.id ?? `result-${toolEvents.length}`,
            phase: "result",
            name: d.name ?? "",
            payload: d.result,
          });
        }
        if (chunk.type === "done" || chunk.type === "error") break;
      }
    } finally {
      typingActive = false;
      clearInterval(typingTimer);
      void adapter.sendTyping(msg.remote_jid, false).catch(() => { /* best-effort */ });
    }

    persistAssistantMessage(thread.thread_id, assistantContent, usedTools, toolEvents);

    const reply = assistantContent.trim();
    // silent_mode (per-route): process the message (records history + runs
    // tools) but suppress the outbound send. Useful for read-only/observer
    // agents on group chats where the user wants logging without auto-posting.
    const silent = route.silent_mode === 1;
    if (reply.length > 0 && !silent) {
      try {
        await adapter.sendText(msg.remote_jid, reply);
      } catch (sendErr) {
        const m = sendErr instanceof Error ? sendErr.message : String(sendErr);
        console.error(`[bridge ${adapter.bridge_id}] sendText failed:`, m);
      }
    }

    publishNotification({
      type: "bridge_message_received",
      bridge_id: adapter.bridge_id,
      remote_jid: msg.remote_jid,
      push_name: msg.push_name,
      is_group: msg.is_group,
      thread_id: thread.thread_id,
      agent_id: agentId,
      preview: reply.replace(/\s+/g, " ").slice(0, 120),
      ts: Date.now(),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[bridge ${adapter.bridge_id}] dispatcher error on ${msg.remote_jid}:`, m);
  }
}
