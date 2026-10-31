import type { ContentPart } from "./types";
import { parseJsonSafe } from "@/lib/utils/json";

// Decode the legacy stored attachment format, not arbitrary request input.
export function parseStoredMessageContent(raw: string): string | ContentPart[] {
  if (!raw.startsWith("[")) return raw;
  const parsed = parseJsonSafe<unknown>(raw);
  return Array.isArray(parsed) && parsed.length > 0
    && typeof parsed[0] === "object" && parsed[0] !== null && "type" in parsed[0]
    ? parsed as ContentPart[] : raw;
}

/** Hide the agent-only trailing reference fence while text is streamed. */
export function stripDeclaredReferencesFence(text: string): string {
  const index = text.indexOf("```jarela-references");
  return index < 0 ? text : text.slice(0, index).trimEnd();
}

export function safeTranscriptFailureReason(code?: string): string {
  switch (code) {
    case "no_model": return "No model is configured for this agent.";
    case "auth_failed":
    case "invalid_api_key": return "The model provider could not authenticate this request.";
    case "rate_limited": return "The model provider rate-limited this request.";
    case "invalid_boundary": return "The selected context boundary is no longer available.";
    case "run_prepare_error": return "The response could not be prepared.";
    case "stream_error": return "The response stream ended unexpectedly.";
    default: return "The response could not be completed.";
  }
}