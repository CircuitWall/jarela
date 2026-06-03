import type { ContentPart } from "@/lib/tools/types";
import type { StreamOptions } from "@/lib/agents/base";

/**
 * Single-shot request shape for `prepareThreadRun`. Replaces the
 * 7+-positional-arg signature this function used to carry. Public callers
 * only set the un-prefixed fields; `_`-prefix fields are internal control
 * state set by the recursive stall-retry path and the `delegate_to_agent`
 * tool. See ADR-0039.
 */
export interface ThreadRunRequest {
  thread_id: string;
  message: string;
  options?: StreamOptions;
  attachments?: ContentPart[];
  signal?: AbortSignal;
  /**
   * Classification tag persisted on the injected user message; surfaces in
   * the chat panel's category-filter toolbar. `null` / undefined = ordinary
   * chat. Values in the wild: `"scheduled_task"`, `"bridge"`, `"delegation"`.
   */
  user_category?: string | null;

  /**
   * ADR-0061 — non-chat channels (scheduler, watcher, bridge observer mode)
   * may want the agent to reply only when there is something material to
   * surface, using the `NO_REPLY` sentinel otherwise. The instruction was
   * previously stapled into the user-message body; now the system prompt
   * carries it via `buildInboundChannelContext` so the body stays clean
   * and the LLM doesn't see two competing copies. Only consulted when
   * `user_category` is set.
   */
  silent?: boolean;

  /**
   * ADR-0042 — explicit context boundary chosen by the user. ISO timestamp.
   * When non-empty, `buildHistoryWindow` uses it as the lower bound for the
   * hot tier (overriding `agentCfg.history_window_hours`) and the run route
   * persists it on the thread so subsequent loads see the same pin. Public
   * callers leave it undefined to keep today's behaviour.
   */
  hot_since?: string | null;

  /** Internal — public callers leave undefined. Decremented across the
   *  stall-retry recursion. */
  _stall_retries_left?: number;

  /** Internal — public callers leave undefined. Decremented across the
   *  ADR-0051 transient-retry recursion (rate_limit / network_error).
   *  Independent of stall budget so a turn can hit one of each. */
  _transient_retries_left?: number;

  /** Internal — public callers leave undefined. When true, do NOT call
   *  `addMessage` for `req.message` and do NOT touch the thread title.
   *  Retry paths set this so synthetic nudges (stall) or replays of the
   *  same message (transient) don't pollute the persisted conversation
   *  history. Without it, every `↻ Auto-retry` recurrence becomes a
   *  permanent user-role row the LLM sees as user input on every future
   *  turn — which the model can't tell apart from a real correction. */
  _skip_persist_message?: boolean;

  /** Internal — public callers leave undefined. When true, append
   *  `req.message` to the in-memory history just before the LLM stream
   *  starts. Used by the stall-retry path where the nudge IS new content
   *  the model needs to see; transient-retry leaves it off because the
   *  original message is already in the DB-built history. */
  _inject_message_into_history?: boolean;

  /** Internal — public callers leave undefined. Set by `delegate_to_agent`
   *  when one agent hands a subtask to another; gates depth + cycles. */
  _delegation_depth?: number;
  _delegation_ancestors?: readonly string[];
}
