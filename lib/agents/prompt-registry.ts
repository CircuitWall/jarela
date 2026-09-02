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
import { DESIGN_QA_PROMPT } from "@/lib/tools/claude-delegate";
import { buildSharedToolCatalogContext } from "@/lib/agents/prepare/system-prompt";
import { BUILTIN_HARNESSES } from "@/lib/agents/harness/presets";

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
  const prompts: StaticPrompt[] = [
    {
      id: "agent.tool-usage-sop",
      source: "lib/agents/prepare/system-prompt.ts",
      purpose: "Cross-agent tool discovery and invocation procedure; cached prefix of every agent turn.",
      text: buildSharedToolCatalogContext(),
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
