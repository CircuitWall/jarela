export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

export interface ThreadSummary {
  thread_id: string;
  agent_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: Message[];
}

export interface MemoryItem {
  namespace: string;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface ModelConfig {
  name: string;
  provider: string;
  model_id: string;
  params: Record<string, unknown>;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export type SSEEventType =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: unknown }
  | { type: "done"; message_id: string; usage: { input_tokens: number; output_tokens: number } }
  | { type: "error"; message: string; code: string };
