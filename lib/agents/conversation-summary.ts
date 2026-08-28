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
        if (p.type === "image_ref") return `[image attachment: ${p.media_type}]`;
        if (p.type === "file") return `[file attachment: ${p.name} (${p.media_type})]`;
        if (p.type === "file_ref") return `[file attachment: ${p.filename} (${p.media_type})]`;
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
      content: [
        "You are compressing a chat transcript into the assistant's working memory.",
        "The next turn will be answered using ONLY your summary plus new user input —",
        "the raw transcript is gone. Optimise for recall, not brevity. Use the full",
        "available output budget; do not artificially shorten.",
        "",
        "Produce the following sections in Markdown. Omit a section only when it has",
        "no content; never invent details.",
        "",
        "## Context",
        "1–3 sentences: what the user is working on and why.",
        "",
        "## User facts & preferences",
        "Task-relevant preferences only: tech stack, environment, tooling,",
        "conventions, constraints, and tone preferences the user expressed.",
        "One bullet per fact. Do NOT record the user's personal identity",
        "(name, contact details, address, demographics, employer) — that is",
        "already injected from the user profile on every turn; repeating it",
        "in the warm summary wastes context and duplicates personal data on",
        "disk.",
        "",
        "## Decisions & conclusions",
        "What was decided or established as true, each with a one-clause reason.",
        "",
        "## Artefacts (verbatim)",
        "Quote exactly — do not paraphrase: file paths, identifiers, URLs, commands,",
        "error messages, version numbers, short code/config snippets, key numbers.",
        "Use fenced code blocks for multi-line snippets.",
        "",
        "## Timeline",
        "Chronological bullets of what happened turn-by-turn, grouping trivial",
        "back-and-forth. Include who said what when it matters for intent.",
        "",
        "## Open threads",
        "Unanswered questions, pending todos, and what the user (or the assistant)",
        "said they would do next. Anything half-finished the assistant owes a",
        "follow-up on.",
        "",
        "Rules:",
        "- Prefer specificity over prose; concrete > abstract.",
        "- Mark uncertainty with \"(unclear)\" rather than guessing.",
        "- Preserve every distinct fact, identifier, and decision from the transcript.",
        "- Do not add meta-commentary about the summary itself.",
      ].join("\n"),
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