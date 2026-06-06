import { getOrCreateAgentThread } from "@/lib/stores/threads";
import { getAgentConfig } from "@/lib/stores/agent-configs";
import { runAgentTurn } from "@/lib/agents/agent-turn";
import { publish as publishNotification } from "@/lib/notifications/bus";
import { resolveRoute } from "./router";
import { formatBridgePrompt } from "./message-role";
import type { BridgeAdapter, InboundMessage } from "./types";

/**
 * Handle one inbound message from a bridge adapter:
 *   1. Resolve the chat → agent route. Unrouted → publish an advisory
 *      event and drop. No thread created, no reply sent.
 *   2. Use `getOrCreateAgentThread(agent_id)` (one-thread-per-agent
 *      invariant — `UNIQUE(agent_id)` on bridge_routes ensures no chat
 *      interleaving).
 *   3. Drive the agent via the canonical `runAgentTurn` helper used by
 *      every external context turn.
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
    // Stamp bridge/chat provenance + sender role onto every inbound prompt.
    // Role framing (user / counterpart / agent) is shared across every
    // bridge adapter via `formatBridgePrompt` — see lib/bridges/message-role.ts.
    const chatName = msg.chat_name ?? msg.push_name ?? "unknown";
    const senderJid = msg.participant_jid ?? msg.remote_jid;
    const senderName = msg.sender_name ?? msg.push_name ?? senderJid;
    const silent = route.silent_mode === 1;
    const promptText = formatBridgePrompt({
      bridge_id: adapter.bridge_id,
      chat_id: msg.remote_jid,
      chat_name: chatName,
      is_group: msg.is_group,
      role: msg.role,
      sender_id: senderJid,
      sender_name: senderName,
      text: msg.text,
      silent,
    });
    // Keep typing outside the queue so users still see "thinking" while
    // waiting behind other queued turns for the same thread.
    const willReply = !silent && msg.role === route.respond_to;
    let typingActive = willReply;
    if (willReply) {
      void adapter.sendTyping(msg.remote_jid, true).catch(() => { /* best-effort */ });
    }
    const typingTimer = setInterval(() => {
      if (!typingActive) return;
      void adapter.sendTyping(msg.remote_jid, true).catch(() => { /* best-effort */ });
    }, 8_000);
    (typingTimer as unknown as { unref?: () => void }).unref?.();

    let reply = "";
    let suppressAssistant = false;
    try {
      const result = await runAgentTurn({
        thread_id: thread.thread_id,
        queue_source: "bridge",
        message: promptText,
        attachments: msg.attachments,
        user_category: "bridge",
        assistant_category: "bridge",
        silent,
      });
      reply = result.assistantContent.trim();
      suppressAssistant = result.skippedAssistant;
    } finally {
      typingActive = false;
      clearInterval(typingTimer);
      if (willReply) {
        void adapter.sendTyping(msg.remote_jid, false).catch(() => { /* best-effort */ });
      }
    }

    // Outbound reply gate: silent_mode (master switch) AND respond_to
    // (per-role trigger). Both must clear for a message to leave the
    // dispatcher. The WhatsApp adapter also re-checks `route.silent_mode`
    // inside its own sendText as a belt-and-suspenders guard, so even a
    // tool that called adapter.sendText directly would be dropped.
    if (reply.length > 0 && willReply) {
      try {
        await adapter.sendText(msg.remote_jid, reply);
      } catch (sendErr) {
        const m = sendErr instanceof Error ? sendErr.message : String(sendErr);
        console.error(`[bridge ${adapter.bridge_id}] sendText failed:`, m);
      }
    }

    if (!silent || !suppressAssistant) {
      publishNotification({
        type: "bridge_message_received",
        bridge_id: adapter.bridge_id,
        remote_jid: msg.remote_jid,
        push_name: msg.push_name,
        is_group: msg.is_group,
        thread_id: thread.thread_id,
        agent_id: agentId,
        preview: suppressAssistant ? "" : reply.replace(/\s+/g, " ").slice(0, 120),
        ts: Date.now(),
      });
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[bridge ${adapter.bridge_id}] dispatcher error on ${msg.remote_jid}:`, m);
  }
}
