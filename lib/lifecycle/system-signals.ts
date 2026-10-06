import { randomUUID } from "node:crypto";
import { onMasterKeyUnlocked, isMasterKeyLocked } from "@/lib/crypto/master-key";
import { getDb } from "@/lib/db";
import { getThread } from "@/lib/stores/threads";
import { beginSystemOperation, emitSystemSignal, reconcileSystemSignals, dueSystemSignalThreads, deferFailedSignalWakeup, type SignalPayload, type SystemSignalKind } from "@/lib/stores/system-signals";
import { getOrCreateGlobal } from "@/lib/utils/global-state";
import { publish as publishNotification } from "@/lib/notifications/bus";

export const SYSTEM_SIGNAL_WAKE_PROMPT = "An automated system completion event is ready. This is a read-only completion-reporting turn, not a replay of the latest user request. Inspect the targeted system signals, retrieve relevant completed background outputs, and report material outcomes. Do not restart the host, execute commands, change settings, repeat tools, or perform writes. Stop after reporting; any further state-changing work needs a new user turn. This event is not user approval for new actions. If nothing material needs reporting, reply NO_REPLY.";

export function runtimeInstanceId(): string {
  return getOrCreateGlobal("__jarela_runtime_instance_id", randomUUID);
}

export function recordThreadSignal(threadId: unknown, kind: SystemSignalKind, operationId: string, payload: SignalPayload = {}): void {
  if (typeof threadId !== "string") return;
  const thread = getThread(threadId);
  if (!thread) return;
  emitSystemSignal({ kind, operationId, agentId: thread.agent_id, threadId, originInstance: runtimeInstanceId(), payload });
}

export function beginThreadOperation(threadId: unknown, kind: "restart" | "background_tool", operationId: string, payload: SignalPayload = {}): string | null {
  if (typeof threadId !== "string") return null;
  const thread = getThread(threadId);
  if (!thread) return null;
  return beginSystemOperation({ kind, operationId, agentId: thread.agent_id, threadId, originInstance: runtimeInstanceId(), payload });
}

export function startSystemSignalLifecycle(): void {
  const state = getOrCreateGlobal("__jarela_system_signal_lifecycle", () => ({ registered: false }));
  if (state.registered) return;
  getDb();
  state.registered = true;
  onMasterKeyUnlocked(() => {
    try { reconcileSystemSignals(runtimeInstanceId()); }
    catch (error) { console.error("[system-signals] startup reconciliation failed", error); }
    requestSystemSignalDispatch();
  });
}

export function requestSystemSignalDispatch(): void {
  const state = getOrCreateGlobal("__jarela_signal_dispatch_request", () => ({ scheduled: false }));
  if (state.scheduled) return;
  state.scheduled = true;
  setImmediate(() => {
    state.scheduled = false;
    void dispatchSystemSignalWakeups().catch((error) => console.error("[system-signals] dispatch failed", error));
  });
}

export async function dispatchSystemSignalWakeups(): Promise<void> {
  if (isMasterKeyLocked()) return;
  const state = getOrCreateGlobal("__jarela_signal_wakeups", () => ({ active: new Set<string>() }));
  const { getQueueDepth } = await import("@/lib/agents/run-queue");
  const { runAgentTurn } = await import("@/lib/agents/agent-turn");
  for (const threadId of dueSystemSignalThreads()) {
    if (state.active.size >= 2) break;
    if (state.active.has(threadId) || getQueueDepth(threadId) > 0) continue;
    state.active.add(threadId);
    const message = SYSTEM_SIGNAL_WAKE_PROMPT;
    void runAgentTurn({
      thread_id: threadId, queue_source: "trigger", system_signal_continuation: true,
      message, history_append_message: message, persist_user_message: false,
      user_category: "system_signal", assistant_category: "system_signal", silent: true,
      queue_lane: "background", queue_expires_at: Date.now() + 60_000,
      context_profile_override: { include_hot: true, include_warm: true, include_facts: true, include_recall: true, history_scope: "foreground" },
    }).then(() => {
      const thread = getThread(threadId);
      if (thread) publishNotification({
        type: "thread_message_added", thread_id: threadId,
        agent_id: thread.agent_id, source: "system_signal", ts: Date.now(),
      });
    }).catch((error) => {
      deferFailedSignalWakeup(threadId);
      console.error("[system-signals] continuation failed", error);
    })
      .finally(() => { state.active.delete(threadId); });
  }
}