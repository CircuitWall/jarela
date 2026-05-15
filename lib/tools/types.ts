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
