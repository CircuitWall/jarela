/**
 * @public
 *
 * Public LLM-provider extension contract.
 *
 * Every type and interface in this file is part of the package's
 * stable public surface (per `package.json#exports`). External provider
 * adapters — both in-tree and `~/.jarela/providers/*.cjs` plugins —
 * conform to {@link ModelProvider}. Removing or breaking any export
 * here counts as a breaking change under the deprecation policy in
 * CONTRIBUTING.md.
 */

import type { ContentPart, InvokeMessage, InvokeResult, OpenAITool } from "@/lib/tools/types";
export type { InvokeMessage, InvokeResult, OpenAITool };

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ProviderParams {
  api_key?: string;
  base_url?: string;
  extra_headers?: Record<string, string>;
  temperature?: number;
  max_tokens?: number;
  // Anthropic extended thinking — pass-through to API body
  thinking?: { type: "enabled"; budget_tokens: number };
  [k: string]: unknown;
}

export interface ProviderStreamResult {
  stream: AsyncIterable<string>;
}

export interface ProviderCatalogModel {
  id: string;
  context_length: number | null;
  max_output_tokens: number | null;
  hosted_on: string | null;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    json_mode: boolean;
    web_search: boolean;
    audio: boolean;
    files: boolean;
  };
}

// Low-level events yielded by streamInvoke. Tool calls arrive as fragments
// (start with id+name, then args_delta chunks); consumers assemble them.
export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call_chunk"; index: number; id?: string; name?: string; args_delta?: string; provider_meta?: Record<string, unknown> }
  | { type: "citation"; source?: string; snippet?: string; url?: string }
  | {
      type: "usage";
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  | { type: "audio_chunk"; mime_type: string; data_b64: string }
  | { type: "provider_event"; name: string; payload: unknown }
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
  // Optional model catalog provider for UI model pickers.
  listModels?(params: ProviderParams): Promise<ProviderCatalogModel[]>;
}
