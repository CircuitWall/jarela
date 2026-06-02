import type { StructuredToolInterface } from "@langchain/core/tools";

// LangGraph/LangChain-compatible tool type. All tools implement this interface.
export type ToolDef = StructuredToolInterface;

// Multipart message content parts (images, files, text)
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string } // base64
  | { type: "file"; name: string; media_type: string; data: string }; // text or base64

export type MessageContent = string | ContentPart[];

// JSON Schema object for OpenAI/Anthropic function calling wire format
export type ToolParamSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
};

export interface ToolContext {
  thread_id?: string;
  /**
   * Per-call wall-clock deadline (ms). Falls back to
   * `getConfig().toolTimeoutMs` when undefined. Pass 0 to disable.
   */
  timeoutMs?: number;
  /**
   * Upstream cancellation signal (typically the agent run's AbortSignal).
   * When fired, the in-flight tool sees its own signal abort and
   * `executeTool` re-throws AbortError so the caller can distinguish
   * user cancel from timeout / tool error.
   */
  runSignal?: AbortSignal;
}

// OpenAI function calling wire format
export type OpenAITool = {
  type: "function";
  function: { name: string; description: string; parameters: ToolParamSchema };
};

// Used in provider invoke() messages
export interface ToolCallRef {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments is JSON string
}

export interface InvokeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string; // for role="tool"
  tool_calls?: ToolCallRef[]; // for role="assistant" when tool calls were made
  // DeepSeek's thinking models (deepseek-reasoner etc.) emit a separate
  // `reasoning_content` field on assistant messages, and the API REQUIRES
  // that field to be echoed back on every subsequent turn — otherwise it
  // returns `400 The reasoning_content in the thinking mode must be passed
  // back to the API`. Carrying it on the generic InvokeMessage lets the
  // OpenAI-compat conversion layer pass it through unchanged.
  reasoning_content?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface InvokeResult {
  text: string | null;
  tool_calls: ToolCall[];
  stop_reason: "stop" | "tool_use" | "length";
}
