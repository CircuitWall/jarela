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
  model_config_name: string | null;
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
  type: "text_delta" | "thinking_delta" | "tool_call" | "tool_result" | "done" | "error";
  data: Record<string, unknown>;
}
