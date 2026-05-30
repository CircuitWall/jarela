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