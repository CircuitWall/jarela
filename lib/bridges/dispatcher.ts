import { getOrCreateAgentThread, type PersistedToolEvent } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { prepareThreadRun, persistAssistantMessage } from "@/lib/agents/run-thread";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { resolveAgent } from "./router";
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
    const agentId = resolveAgent(adapter.bridge_id, msg.remote_jid);
    if (!agentId) {
      // Advisory event so the UI can offer a one-click "Add route" hint
      // without the user having to scrape logs for the JID.
      publishNotification({
        type: "bridge_unrouted",
        bridge_id: adapter.bridge_id,
        remote_jid: msg.remote_jid,
        push_name: msg.push_name,
        is_group: msg.is_group,
        preview: msg.text.slice(0, 80),
        ts: Date.now(),
      });
      console.log(`[bridge ${adapter.bridge_id}] dropped: no route for ${msg.remote_jid} (${msg.push_name ?? "?"})`);
      return;
    }

    const agent = getAgentConfig(agentId);
    if (!agent) {
      console.warn(`[bridge ${adapter.bridge_id}] route points at missing agent ${agentId}, dropping`);
      return;
    }

    const thread = getOrCreateAgentThread(agentId);
    const prepared = await prepareThreadRun(thread.thread_id, msg.text);

    let assistantContent = "";
    const usedTools: string[] = [];
    const toolEvents: PersistedToolEvent[] = [];
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

    persistAssistantMessage(thread.thread_id, assistantContent, usedTools, toolEvents);

    const reply = assistantContent.trim();
    if (reply.length > 0) {
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
