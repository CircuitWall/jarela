// Per-category context profile for an agent turn.
//
// Different turn sources need different slices of the agent's context.
// A user chatting wants the full hot+warm history of their thread; a
// one-shot extension "fill this field" call wants ONLY the per-call
// instruction + page context so prior chat doesn't bleed in; a bridge
// message wants hot+warm because chat messages are connected; a
// scheduled task wants neither hot nor warm because each firing is a
// standalone event.
//
// This module is the single source of truth. To change the policy for
// a category, edit `TURN_PROFILES` below — every external runner
// (extension, bridge, scheduler, watcher, trigger, delegate, HTTP user
// run) resolves its profile through `resolveTurnProfile` and threads
// it into `prepareThreadRun`, which applies the toggles at LLM-call
// assembly time.
//
// Facts and recall are global to the agent (memory store + embeddings)
// and tools come from the agent config — they're NOT per-thread state
// — so disabling them here just means "don't paste the recall/facts
// blocks into THIS turn's system prompt". The agent can still call
// `memory_read` / `memory_list` / `web_search` etc. if its tool
// allow-list includes them.

import type { AgentTurnQueueSource } from "@/lib/agents/agent-turn";

export interface TurnContextProfile {
  /** Paste the recent thread messages into the LLM call. */
  include_hot: boolean;
  /** Paste the warm-summary block into the system prompt. */
  include_warm: boolean;
  /** Paste the `--- Facts memory ---` block into the system prompt. */
  include_facts: boolean;
  /** Paste the embedding-based recall block into the system prompt. */
  include_recall: boolean;
  /** Which durable conversation rows may enter this turn's hot/warm history. */
  history_scope?: "foreground" | "bridge" | "all" | "none";
}

export const FULL_PROFILE: TurnContextProfile = {
  include_hot: true,
  include_warm: true,
  include_facts: true,
  include_recall: true,
  history_scope: "all",
};

export const FOREGROUND_PROFILE: TurnContextProfile = {
  ...FULL_PROFILE,
  history_scope: "foreground",
};

export const BRIDGE_PROFILE: TurnContextProfile = {
  ...FULL_PROFILE,
  // Bridge history is channel-scoped and intentionally skips the thread's
  // foreground warm-summary cache.
  include_warm: false,
  history_scope: "bridge",
};

export const ONE_SHOT_PROFILE: TurnContextProfile = {
  include_hot: false,
  include_warm: false,
  include_facts: false,
  include_recall: false,
  history_scope: "none",
};

// Category → profile. Add new categories alongside `AgentTurnQueueSource`.
// To change a category's behaviour, edit ONLY this table.
export const TURN_PROFILES: Record<AgentTurnQueueSource, TurnContextProfile> = {
  // Normal chat needs the full thread context.
  user:      FOREGROUND_PROFILE,
  // Bridge messages are conversational — keep the connection between turns.
  bridge:    BRIDGE_PROFILE,
  // Delegate hand-offs need the parent's recent context so the child can
  // pick up the conversation thread.
  delegate:  FULL_PROFILE,
  // One-shot automation events: each firing is standalone. Memory + tools
  // still available, but no prior chat history bleeds into the answer.
  extension: ONE_SHOT_PROFILE,
  scheduler: ONE_SHOT_PROFILE,
  watcher:   ONE_SHOT_PROFILE,
  trigger:   ONE_SHOT_PROFILE,
};

export function resolveTurnProfile(
  source: AgentTurnQueueSource | null | undefined,
  override?: Partial<TurnContextProfile> | null,
): TurnContextProfile {
  const base = source ? TURN_PROFILES[source] : FULL_PROFILE;
  if (!override) return base;
  return { ...base, ...override };
}
