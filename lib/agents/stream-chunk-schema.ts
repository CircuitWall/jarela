// Single source of truth for the agent stream chunk contract.
//
// Two on-the-wire shapes derive from the per-type payload schemas defined here:
//
//   - StreamChunk (server-internal): { type, data: <payload> }
//     Used inside lib/agents/* and lib/agents/run-registry.ts. The agent
//     stream yields these; the registry buffers / replays them.
//
//   - SSEEventType (wire / client-facing): { type, ...payload }
//     Flattened by app/api/v1/threads/[thread_id]/run/route.ts at SSE
//     emit time so EventSource consumers don't have to dereference `data`.
//
// Both server emit (broadcast) and client consume (useSSE) safe-parse against
// these schemas so version-skew between client + server fails loudly with a
// console warning instead of crashing the chat reducer.

import { z } from "zod";

// Per-type payload schemas. Keep field names aligned with the existing
// emit sites in lib/agents/llm.ts so this is a typing tightening, not a
// rename.
export const TextDeltaPayloadSchema = z.object({
  delta: z.string(),
});

export const ThinkingDeltaPayloadSchema = z.object({
  delta: z.string(),
});

export const ToolCallPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

export const ToolResultPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  result: z.unknown(),
  // First-class error metadata. Present when the underlying tool returned a
  // `kind:"error"` envelope (PR-4) or a legacy `{error, code}` shape; absent
  // on success. Promoted out of `result` so the chat UI can render code-
  // specific affordances (retry, "open settings", etc.) without parsing the
  // payload, and so the agent's stream consumer can branch on it directly.
  // See ADR-0049.
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  // ADR-0056 — domain-specific recovery hint from the tool itself.
  // Complements the generic playbook in the system prompt: the tool knows
  // best how to recover from its own error (e.g. "call jira_list_projects
  // to discover valid keys"). The agent prefers the hint when it exists.
  error_hint: z.string().optional(),
});

export const DoneUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  source: z.enum(["provider", "estimate"]).optional(),
});

export const DonePayloadSchema = z.object({
  message_id: z.string(),
  usage: DoneUsageSchema.optional(),
  provider: z.string().optional(),
  model_id: z.string().optional(),
  model_config_name: z.string().nullable().optional(),
  aborted: z.boolean().optional(),
});

export const ErrorPayloadSchema = z.object({
  message: z.string(),
  code: z.string(),
});

export const RunInFlightPayloadSchema = z.object({
  thread_id: z.string(),
});

// Server-internal envelope. `data` is `Record<string, unknown>` here so we
// can keep emit-site code untyped (it casts at the boundary); the parsed
// version below is the strict one consumers should depend on.
export const StreamChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), data: TextDeltaPayloadSchema }),
  z.object({ type: z.literal("thinking_delta"), data: ThinkingDeltaPayloadSchema }),
  z.object({ type: z.literal("tool_call"), data: ToolCallPayloadSchema }),
  z.object({ type: z.literal("tool_result"), data: ToolResultPayloadSchema }),
  z.object({ type: z.literal("done"), data: DonePayloadSchema }),
  z.object({ type: z.literal("error"), data: ErrorPayloadSchema }),
]);

// Flat wire shape — the SSE-on-the-wire form clients see. Adds `run_in_flight`
// which is emitted directly by the route, never by the agent stream itself,
// hence not in StreamChunkSchema.
export const SSEEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta") }).extend(TextDeltaPayloadSchema.shape),
  z.object({ type: z.literal("thinking_delta") }).extend(ThinkingDeltaPayloadSchema.shape),
  z.object({ type: z.literal("tool_call") }).extend(ToolCallPayloadSchema.shape),
  z.object({ type: z.literal("tool_result") }).extend(ToolResultPayloadSchema.shape),
  z.object({ type: z.literal("done") }).extend(DonePayloadSchema.shape),
  z.object({ type: z.literal("error") }).extend(ErrorPayloadSchema.shape),
  z.object({ type: z.literal("run_in_flight") }).extend(RunInFlightPayloadSchema.shape),
]);

export type StreamChunkParsed = z.infer<typeof StreamChunkSchema>;
export type SSEEventParsed = z.infer<typeof SSEEventSchema>;

export type StreamChunkType = StreamChunkParsed["type"];
export type SSEEventTypeName = SSEEventParsed["type"];

// Defensive parse for inbound SSE on the client. Returns the parsed event
// or null when the payload is malformed / from a future server version.
// Caller logs once and skips the event rather than crashing the reducer.
export function safeParseSSEEvent(raw: unknown): SSEEventParsed | null {
  const result = SSEEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// Defensive parse for the server-internal envelope. Used by broadcast() so a
// mis-shaped chunk emitted by a regression doesn't smear malformed JSON onto
// every subscriber. Returns the parsed chunk or null on mismatch.
export function safeParseStreamChunk(raw: unknown): StreamChunkParsed | null {
  const result = StreamChunkSchema.safeParse(raw);
  return result.success ? result.data : null;
}
