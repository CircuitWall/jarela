import type { ContentPart } from "@/lib/tools/types";
import type { StreamOptions } from "@/lib/agents/base";
import type { TurnContextProfile } from "@/lib/agents/turn-profile";

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
   * ADR-0042 — explicit context boundary chosen by the user. ISO timestamp.
   * When non-empty, `buildHistoryWindow` uses it as the lower bound for the
   * hot tier (overriding `agentCfg.history_window_hours`) and the run route
   * persists it on the thread so subsequent loads see the same pin. Public
   * callers leave it undefined to keep today's behaviour.
   */
  hot_since?: string | null;

  /**
   * Per-category context profile. When set, suppresses one or more of
   * hot history / warm summary / facts block / recall block from the LLM
   * call. Resolved by external runners (extension, bridge, scheduler,
   * watcher, trigger, delegate, HTTP user run) from
   * `@/lib/agents/turn-profile` so the policy lives in one place. When
   * undefined, defaults to the full context (today's behaviour).
   */
  context_profile?: TurnContextProfile;

  /**
   * Skip the post-stream stall-retry + strict-citation audit wrapper for
   * this turn. Use for one-shot callers (browser-extension fill / rewrite)
   * that consume `assistantContent` as raw text and would otherwise type
   * the visible `↻` separator and the original stalled prose into the
   * user's input field. Chat callers leave undefined.
   */
  disable_quality_gates?: boolean;

  /**
   * Internal - public callers leave undefined. When set by the submission
   * path, this freezes the effective model config for the turn so queued
   * runs do not drift if the agent model changes before execution starts.
   */
  _pinned_model_config_name?: string | null;

  /** Internal — public callers leave undefined. Decremented across the
   *  stall-retry recursion. */
  _stall_retries_left?: number;

  /**
   * Internal — public callers leave undefined. When set, prepareThreadRun
   * will NOT call addMessage/touchThread for this request. The stall-retry
   * recursion sets this so its synthetic `↻ Auto-retry: …` nudges don't
   * become permanent user-role rows that the LLM later mistakes for real
   * user input.
   */
  _skip_persist_message?: boolean;

  /**
   * Internal — public callers leave undefined. When set, prepareThreadRun
   * appends the request's message to the in-memory history just before the
   * LLM stream so the model still sees the nudge for THIS turn even though
   * it isn't persisted. Pairs with `_skip_persist_message` for stall-retry.
   */
  _inject_message_into_history?: boolean;

  /** Internal — public callers leave undefined. Set by `delegate_to_agent`
   *  when one agent hands a subtask to another; gates depth + cycles. */
  _delegation_depth?: number;
  _delegation_ancestors?: readonly string[];
}
