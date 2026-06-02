import type { ContentPart } from "@/lib/tools/types";
import type { ModelProvider, ProviderMessage, ProviderParams } from "@/lib/providers/types";

export function transcriptText(raw: string): string {
  if (!raw.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return raw;
    return (parsed as ContentPart[])
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "image") return `[image attachment: ${p.media_type}]`;
        if (p.type === "file") return `[file attachment: ${p.name} (${p.media_type})]`;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  } catch {
    return raw;
  }
}

function summaryMessages(transcript: string): ProviderMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a concise summarizer. Summarize the conversation below in 3-7 bullet points, capturing key facts, decisions, and context that would be useful to remember later.",
    },
    {
      role: "user",
      content: `Conversation to summarize:\n\n${transcript}`,
    },
  ];
}

export async function summarizeTranscript(
  provider: Pick<ModelProvider, "chat">,
  modelId: string,
  providerParams: ProviderParams,
  transcript: string,
): Promise<string> {
  const trimmed = transcript.trim();
  if (!trimmed) return "";

  const { stream } = await provider.chat(modelId, summaryMessages(trimmed), providerParams);
  let summary = "";
  for await (const chunk of stream) summary += chunk;
  return summary.trim();
}

export interface SummarizeWithRetryOptions {
  /**
   * Total attempts (initial + retries). Default 2 — one retry on the same
   * provider/model is enough to cover transient network blips without
   * paying double cost on every turn.
   */
  attempts?: number;
  /**
   * Optional ms to wait between attempts. Default 250 — keeps total turn
   * latency bounded while letting a flapping provider recover.
   */
  delayMs?: number;
}

export interface SummarizeWithRetryResult {
  /** Summary text on success, empty string on exhaustion. */
  text: string;
  /** Number of attempts actually made (1..attempts). */
  attempts: number;
  /** Last error captured when every attempt failed. */
  lastError?: unknown;
}

/**
 * Retry-aware summariser for the warm tier. Wraps `summarizeTranscript` with
 * a small retry budget so a transient provider hiccup doesn't silently empty
 * the warm context across a long task. Returns a result object the caller
 * uses to set the thread's `warm_summary_status` so the UI can surface
 * degraded compaction.
 */
export async function summarizeTranscriptWithRetry(
  provider: Pick<ModelProvider, "chat">,
  modelId: string,
  providerParams: ProviderParams,
  transcript: string,
  options: SummarizeWithRetryOptions = {},
): Promise<SummarizeWithRetryResult> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const text = await summarizeTranscript(provider, modelId, providerParams, transcript);
      return { text, attempts: i + 1 };
    } catch (err) {
      lastError = err;
      if (i < attempts - 1 && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return { text: "", attempts, lastError };
}