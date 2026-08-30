import type { RouteDecisionMetadata } from "@/api/types";

export interface StreamFilters {
  include_tools?: boolean;
  include_thinking?: boolean;
}

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface AgentRunConfig {
  system_prompt: string;
  allowed_tools: string[];   // empty = all tools
  tool_permission_map?: Array<{
    name: string;
    category: string;
    capability: string;
    source: string;
    permission: "enabled" | "disabled" | "unavailable";
    permission_reason?: string | null;
  }>;
  model_config_name: string | null;
  route_decision?: RouteDecisionMetadata | null;
  /** Budget-derived output token ceiling for this turn. Applied as `max_tokens`
   *  when the model config does not explicitly set one, so the provider never
   *  over-allocates output tokens beyond what the context budget reserved. */
  output_reserve_tokens?: number;
  /**
   * Per-tool credential overrides (`{ toolName: credentialId }`). Forwarded
   * to the tool wrapper so the integrations store can pick the right
   * credential when more than one is configured for a given provider.
   * Empty/undefined = every tool resolves via the integration's default.
   */
  tool_credentials?: Record<string, string>;
  /**
   * Set when this run is the body of a `delegate_to_agent` tool call.
   * Read by the delegate tool itself to enforce depth + cycle limits when
   * a delegated child agent tries to delegate further. Public callers leave
   * this undefined; the delegate tool sets it when recursively invoking
   * `prepareThreadRun`.
   */
  delegation?: {
    depth: number;
    ancestors: readonly string[]; // chain of parent agent ids, oldest first
  };
}

export interface StreamOptions {
  filters?: StreamFilters;
  tool_policy?: ToolPolicy;
  agent_run_config?: AgentRunConfig;
  // Back-compat: pre-rename clients may still send "normal" / "advanced".
  // Server-side normalization lives in lib/agents/run-thread.ts.
  ui_experience_mode?: "essential" | "full" | "normal" | "advanced";
}

export interface StreamChunk {
  // "heartbeat" exists so silent provider activity — most commonly an
  // AIMessageChunk that carries only partial tool-call argument deltas
  // (e.g. while the model is streaming a large file_write body) — can
  // reset the idle watchdog without surfacing anything to subscribers.
  // See broadcast() in run-registry.ts: heartbeats bump last_chunk_at
  // and are dropped before buffering / fan-out, so the SSE wire never
  // carries meaningless tick events.
  //
  // "tool_progress" carries incremental status from INSIDE a still-running
  // tool call (e.g. claude_delegate relaying the sub-agent's own turns) —
  // unlike "tool_call"/"tool_result", a call can emit any number of these
  // between its call and result. `data` shape: { id, name, text }, where
  // `id` matches the same call's "tool_call" chunk id. Emitted via
  // lib/tools/workspace-context.ts's reportToolProgress() -> the tool's
  // LangGraph-provided `config.writer` -> "custom" stream mode in
  // lib/agents/llm.ts (ADR-0073).
  type: "text_delta" | "thinking_delta" | "tool_call" | "tool_result" | "tool_progress" | "done" | "error" | "heartbeat" | "status";
  data: Record<string, unknown>;
}
