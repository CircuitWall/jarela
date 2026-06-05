// Shared collector for agent stream consumers.
//
// Previously three near-identical drain loops lived in:
//   - app/api/v1/threads/[thread_id]/run/route.ts  (HTTP run)
//   - lib/scheduler/index.ts                       (cron tasks)
//   - lib/bridges/dispatcher.ts                    (WhatsApp / bridges)
//
// They all read `prepared.stream`, accumulate `text_delta` into a single
// assistant string, record `tool_call`/`tool_result` events, stop on
// `done`/`error`, and surface the terminal state. This helper unifies that.

import type { StreamChunk } from "@/lib/agents/base";
import type { PersistedToolEvent } from "@/lib/stores/threads";
import type { AssistantUsageSnapshot } from "@/lib/agents/run-thread";

export interface CollectedRun {
  assistantContent: string;
  usedTools: string[];
  toolEvents: PersistedToolEvent[];
  terminal: "done" | "error";
  errorMessage?: string;
  // ADR-0041: provider-reported token usage + model/provider snapshot from
  // the terminal `done` chunk. Undefined when the stream errored out before
  // a usage event arrived (or the provider didn't report one).
  usage?: AssistantUsageSnapshot;
}

export interface CollectStreamOptions {
  // Called for every chunk before it is interpreted. Use for live broadcast
  // (HTTP SSE, websocket, etc.). Throwing here aborts the run with terminal
  // = "error".
  onChunk?: (chunk: StreamChunk) => void;
}

/** Drain an async stream of `StreamChunk` into a single `CollectedRun`. */
export async function collectStream(
  stream: AsyncIterable<StreamChunk>,
  opts: CollectStreamOptions = {},
): Promise<CollectedRun> {
  const result: CollectedRun = {
    assistantContent: "",
    usedTools: [],
    toolEvents: [],
    terminal: "done",
  };

  try {
    for await (const chunk of stream) {
      opts.onChunk?.(chunk);
      switch (chunk.type) {
        case "text_delta": {
          result.assistantContent += (chunk.data.delta as string) ?? "";
          break;
        }
        case "tool_call": {
          const d = chunk.data as { id?: string; name?: string; arguments?: unknown };
          if (d.name) result.usedTools.push(d.name);
          result.toolEvents.push({
            id: d.id ?? `call-${result.toolEvents.length}`,
            phase: "call",
            name: d.name ?? "",
            payload: d.arguments,
          });
          break;
        }
        case "tool_result": {
          const d = chunk.data as { id?: string; name?: string; result?: unknown };
          result.toolEvents.push({
            id: d.id ?? `result-${result.toolEvents.length}`,
            phase: "result",
            name: d.name ?? "",
            payload: d.result,
          });
          break;
        }
        case "error": {
          result.terminal = "error";
          const msg = (chunk.data as { message?: unknown })?.message;
          if (typeof msg === "string") result.errorMessage = msg;
          return result;
        }
        case "done": {
          const d = chunk.data as {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
              source?: string;
            };
            provider?: string;
            model_id?: string;
            model_config_name?: string | null;
          };
          if (d?.usage && d.provider && d.model_id && d.usage.source === "provider") {
            result.usage = {
              input_tokens: d.usage.input_tokens ?? 0,
              output_tokens: d.usage.output_tokens ?? 0,
              cache_creation_input_tokens: d.usage.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: d.usage.cache_read_input_tokens ?? 0,
              provider: d.provider,
              model_id: d.model_id,
              model_config_name: d.model_config_name ?? null,
            };
          }
          return result;
        }
        // thinking_delta and unknown types are pass-through (already
        // forwarded to onChunk above).
      }
    }
  } catch (err) {
    result.terminal = "error";
    result.errorMessage = err instanceof Error ? err.message : String(err);
  }

  return result;
}
