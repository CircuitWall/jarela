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

  /** Internal — public callers leave undefined. Decremented across the
   *  stall-retry recursion. */
  _stall_retries_left?: number;

  /** Internal — public callers leave undefined. Set by `delegate_to_agent`
   *  when one agent hands a subtask to another; gates depth + cycles. */
  _delegation_depth?: number;
  _delegation_ancestors?: readonly string[];
}
