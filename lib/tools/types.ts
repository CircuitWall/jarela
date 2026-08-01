/**
 * @public
 *
 * Public tool extension contract.
 *
 * Every type and interface in this file is part of the package's
 * stable public surface (per `package.json#exports`). External tool
 * authors — both in-tree built-ins and `~/.jarela/tools/*.cjs` plugins —
 * use these to describe arguments, results, and message shapes. Removing
 * or breaking any export here counts as a breaking change under the
 * deprecation policy in CONTRIBUTING.md.
 */

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
  // Provider-specific opaque metadata to echo back on replay. Currently used
  // for Gemini's `thoughtSignature` (required on functionCall parts once the
  // model has emitted a thought signature earlier in the turn — omitting it
  // makes the follow-up request 400 with API_KEY_INVALID lookalike errors).
  provider_meta?: Record<string, unknown>;
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
  provider_meta?: Record<string, unknown>;
}

export interface InvokeResult {
  text: string | null;
  tool_calls: ToolCall[];
  stop_reason: "stop" | "tool_use" | "length";
}
