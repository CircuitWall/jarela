import type { InvokeMessage, InvokeResult, OpenAITool } from "@/lib/tools/types";
export type { InvokeMessage, InvokeResult, OpenAITool };

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderParams {
  api_key?: string;
  base_url?: string;
  extra_headers?: Record<string, string>;
  temperature?: number;
  max_tokens?: number;
  // Internal-specific
  auth_header_name?: string;
  auth_header_value?: string;
  // Anthropic extended thinking — pass-through to API body
  thinking?: { type: "enabled"; budget_tokens: number };
  [k: string]: unknown;
}

export interface ProviderStreamResult {
  stream: AsyncIterable<string>;
}

// Low-level events yielded by streamInvoke. Tool calls arrive as fragments
// (start with id+name, then args_delta chunks); consumers assemble them.
export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call_chunk"; index: number; id?: string; name?: string; args_delta?: string }
  | { type: "stop"; reason: "stop" | "tool_use" | "length" };

export interface ModelProvider {
  readonly name: string;
  chat(
    model_id: string,
    messages: ProviderMessage[],
    params: ProviderParams,
  ): Promise<ProviderStreamResult>;
  // Non-streaming structured call. Providers without tool support omit this.
  invoke?(
    model_id: string,
    messages: InvokeMessage[],
    params: ProviderParams,
    tools: OpenAITool[],
  ): Promise<InvokeResult>;
  // Streaming structured call. Yields token + thinking + tool-fragment events
  // as they arrive. Providers without streaming support omit this.
  streamInvoke?(
    model_id: string,
    messages: InvokeMessage[],
    params: ProviderParams,
    tools: OpenAITool[],
  ): AsyncIterable<ProviderStreamEvent>;
  // Generate embeddings for one or more inputs. Used for semantic recall over
  // memory and chat history. Providers without embedding support omit this.
  embed?(
    model_id: string,
    inputs: string[],
    params: ProviderParams,
  ): Promise<number[][]>;
}
