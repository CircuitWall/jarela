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
}

export interface StreamOptions {
  filters?: StreamFilters;
  tool_policy?: ToolPolicy;
  agent_run_config?: AgentRunConfig;
}

export interface StreamChunk {
  type: "text_delta" | "thinking_delta" | "tool_call" | "tool_result" | "done" | "error";
  data: Record<string, unknown>;
}
