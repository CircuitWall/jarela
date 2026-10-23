/**
 * Every prompt Jarela sends to a model, in one place.
 *
 * Prompts are assembled from many builders and scattered constants, so
 * "is the wording still correct?" is impossible to answer by reading any
 * single file. This registry is the inventory the verifier walks
 * (`lib/agents/prompt-registry.test.ts`) and the dump script renders.
 *
 * Adding a prompt without registering it fails the coverage test, so the
 * inventory cannot silently go stale.
 */
import { SYSTEM_PROMPT as CITATION_CHECKER_PROMPT } from "@/lib/agents/citation-checker";
import { SYSTEM_PROMPT as HALLUCINATION_CLASSIFIER_PROMPT } from "@/lib/agents/hallucination-classifier";
import { SYSTEM_PROMPT as PRICING_EXTRACT_PROMPT } from "@/lib/pricing/llm-extract";
import { DESIGN_QA_PROMPT } from "@/lib/tools/delegation/claude-delegate";
import { buildSharedToolCatalogContext } from "@/lib/agents/prepare/system-prompt";
import { BUILTIN_HARNESSES } from "@/lib/agents/harness/presets";
import { SYSTEM_SIGNAL_WAKE_PROMPT } from "@/lib/lifecycle/system-signals";
import { buildConversationSummaryMessages, type SummaryTopicSegment } from "@/lib/agents/conversation-summary";
import { buildTopicGroupingMessages, buildTopicRecapMessages } from "@/lib/agents/compaction-pipeline";
import type { ProviderMessage } from "@/lib/providers/types";
import { buildFabricationNudge, buildCitationRetryNudge } from "./retry-prompts";
import { buildFirstRunAgentInstructions, buildFirstRunKickoff } from "./first-run-onboarding";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface StaticPrompt {
  id: string;
  /** Source file, so a failing assertion points at what to edit. */
  source: string;
  /** What this prompt is responsible for. */
  purpose: string;
  text: string;
}

/**
 * Prompts whose text is fixed at build time. The per-turn agent system
 * prompt is not here because it is assembled from context — the verifier
 * builds it from fixtures instead.
 */
export function listStaticPrompts(): StaticPrompt[] {
  const conversationSummary = buildConversationSummaryMessages(
    "[seq=42] [2026-10-09T10:00:00.000Z] User: Example transcript row.",
  ).map((message) => `${message.role.toUpperCase()}\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`).join("\n\n");
  const renderMessages = (messages: ProviderMessage[]) => messages
    .map((message) => `${message.role.toUpperCase()}\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`)
    .join("\n\n");
  const sampleTopic: SummaryTopicSegment = {
    title: "Example earlier topic",
    start_seq: 40,
    end_seq: 44,
    start_at: "2026-10-09T10:00:00.000Z",
    end_at: "2026-10-09T10:05:00.000Z",
    recap: "Example recap of the earlier topic.",
    facts: [{ subject: "Example preference", content: "The user prefers examples.", tags: [], confidence: "explicit", key: "facts/example-preference" }],
    message_count: 4,
  };
  const sampleNewMessages = "[seq=50] [2026-10-09T11:00:00.000Z] User: Example newer message.\n\n[seq=51] [2026-10-09T11:00:05.000Z] Assistant: Example reply.";
  const compactionGroup = renderMessages(buildTopicGroupingMessages(sampleNewMessages, [sampleTopic]));
  const compactionRecap = renderMessages(buildTopicRecapMessages({ title: sampleTopic.title, continues: "t1", seqs: [50, 51] }, sampleTopic, sampleNewMessages));
  const channelGroup = renderMessages(buildTopicGroupingMessages(sampleNewMessages, [sampleTopic], "scheduled_task"));
  const channelRecap = renderMessages(buildTopicRecapMessages({ title: sampleTopic.title, continues: "t1", seqs: [50, 51] }, sampleTopic, sampleNewMessages, "scheduled_task"));
  const prompts: StaticPrompt[] = [
    {
      id: "skill.personal-briefing",
      source: "lib/skills/builtins/personal-briefing/SKILL.md",
      purpose: "Pairs read-only personal briefing retrieval and drafting with executable structural checks and explicit validation limits.",
      text: readFileSync(join(process.cwd(), "lib", "skills", "builtins", "personal-briefing", "SKILL.md"), "utf8"),
    },
    {
      id: "agent.retry-fabrication",
      source: "lib/agents/retry-prompts.ts",
      purpose: "Repairs an unsupported action claim while retaining the complete substantive answer.",
      text: buildFabricationNudge("Example action claim has no confirmed tool result"),
    },
    {
      id: "agent.retry-citation",
      source: "lib/agents/retry-prompts.ts",
      purpose: "Repairs unsupported citations while retaining the complete substantive answer.",
      text: buildCitationRetryNudge([{ text: "Example claim", reason: "No verified source" }]),
    },
    {
      id: "agent.first-run-onboarding",
      source: "lib/agents/first-run-onboarding.ts",
      purpose: "Guides a new user through a short, consent-based assistant-personalization conversation.",
      text: buildFirstRunKickoff({
        userName: "Alex Example",
        about: "I coordinate a small research team.",
        starterGoal: "Help me turn meeting notes into clear next steps.",
        assistantName: "Nova",
        modelProvider: "OpenAI",
        modelName: "gpt-example",
      }),
    },
    {
      id: "agent.first-run-instructions",
      source: "lib/agents/first-run-onboarding.ts",
      purpose: "Privately guides the starter agent through user-approved personalization without exposing setup operations in chat.",
      text: buildFirstRunAgentInstructions("Help me plan weekly check-ins."),
    },
    {
      id: "agent.system-signal-wakeup",
      source: "lib/lifecycle/system-signals.ts",
      purpose: "Bounded continuation of already-authorized work after targeted runtime completion signals.",
      text: SYSTEM_SIGNAL_WAKE_PROMPT,
    },
    {
      id: "agent.tool-usage-sop",
      source: "lib/agents/prepare/system-prompt.ts",
      purpose: "Cross-agent tool discovery and invocation procedure; cached prefix of every agent turn.",
      text: buildSharedToolCatalogContext(),
    },
    {
      id: "agent.conversation-summary",
      source: "lib/agents/conversation-summary.ts",
      purpose: "Compress warm chat context while preserving source seq boundaries for topic alignment.",
      text: conversationSummary,
    },
    {
      id: "agent.compaction-group",
      source: "lib/agents/compaction-pipeline.ts",
      purpose: "Compaction step 1: group newly aged-out messages into topics, each new or continuing a stored warm topic.",
      text: compactionGroup,
    },
    {
      id: "agent.compaction-topic-recap",
      source: "lib/agents/compaction-pipeline.ts",
      purpose: "Compaction step 2: recap one topic, newest detail first, merging its stored recap and listing durable facts.",
      text: compactionRecap,
    },
    {
      id: "agent.compaction-group-automation",
      source: "lib/agents/compaction-pipeline.ts",
      purpose: "Compaction step 1 for an automation channel (scheduled_task shown; watcher and bridge differ only in wording).",
      text: channelGroup,
    },
    {
      id: "agent.compaction-topic-recap-automation",
      source: "lib/agents/compaction-pipeline.ts",
      purpose: "Compaction step 2 for an automation channel (scheduled_task shown); recap focuses on runs, outcomes and failures.",
      text: channelRecap,
    },
    {
      id: "audit.citation-checker",
      source: "lib/agents/citation-checker.ts",
      purpose: "Extracts factual claims from an assistant turn for citation auditing.",
      text: CITATION_CHECKER_PROMPT,
    },
    {
      id: "audit.hallucination-classifier",
      source: "lib/agents/hallucination-classifier.ts",
      purpose: "Judges whether an agent turn stalled instead of doing the work.",
      text: HALLUCINATION_CLASSIFIER_PROMPT,
    },
    {
      id: "pricing.llm-extract",
      source: "lib/pricing/llm-extract.ts",
      purpose: "Extracts model pricing from a provider's pricing page.",
      text: PRICING_EXTRACT_PROMPT,
    },
    {
      id: "delegate.design-qa",
      source: "lib/tools/claude-delegate.ts",
      purpose: "Appended system prompt when a delegated Claude run must escalate design questions.",
      text: DESIGN_QA_PROMPT,
    },
  ];

  for (const harness of BUILTIN_HARNESSES) {
    for (const [section, value] of Object.entries(harness.sections)) {
      if (value.body.trim().length === 0) continue;
      prompts.push({
        id: `harness.${harness.id}.${section}`,
        source: "lib/agents/harness/presets.ts",
        purpose: `Harness "${harness.name}" ${section} section, spliced into the agent-stable prompt block.`,
        text: value.body,
      });
    }
  }

  return prompts;
}

/**
 * Files whose text ends up inside the assembled agent system prompt. Editing
 * any of them changes every system-prompt variant, so a review cannot stop at
 * the one block that was edited.
 */
export const SYSTEM_PROMPT_SOURCE_PREFIXES = [
  "lib/agents/prepare/",
  "lib/agents/harness/",
  "lib/agents/adaptive-persona.ts",
  "lib/agents/usage-strategy.ts",
] as const;

/**
 * Which assembled prompts a set of changed files can affect. Drives
 * `npm run prompts:dump -- --changed`, so a prompt review narrows to the
 * artifacts the change actually reaches.
 */
export function promptsAffectedBy(changedPaths: readonly string[]): {
  systemPrompt: boolean;
  staticPromptIds: string[];
} {
  const normalized = changedPaths.map((p) => p.replace(/\\/g, "/"));
  const systemPrompt = normalized.some((p) =>
    SYSTEM_PROMPT_SOURCE_PREFIXES.some((prefix) => p.startsWith(prefix)));
  const staticPromptIds = listStaticPrompts()
    .filter((prompt) => normalized.includes(prompt.source))
    .map((prompt) => prompt.id);
  return { systemPrompt, staticPromptIds };
}
