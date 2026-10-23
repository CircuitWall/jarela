import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";

const identifier = z.string().trim().min(1).max(200);
const inputSchema = z.object({
  sources: z.array(z.object({
    id: identifier,
    available: z.boolean(),
  })).min(1).max(100),
  briefing: z.object({
    items: z.array(z.object({
      text: z.string().trim().min(1).max(2000),
      source_ids: z.array(identifier).min(1).max(20),
    })).max(40),
    unavailable_source_ids: z.array(identifier).max(100),
  }),
});

const contract = inputSchema.superRefine(({ sources, briefing }, ctx) => {
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (byId.size !== sources.length) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "Source IDs must be unique." });
  }
  const gaps = new Set(briefing.unavailable_source_ids);
  if (gaps.size !== briefing.unavailable_source_ids.length) {
    ctx.addIssue({ code: "custom", path: ["briefing", "unavailable_source_ids"], message: "Source gaps must be unique." });
  }
  for (const [index, id] of briefing.unavailable_source_ids.entries()) {
    if (!byId.has(id) || byId.get(id)?.available !== false) {
      ctx.addIssue({ code: "custom", path: ["briefing", "unavailable_source_ids", index], message: "A source gap must identify an unavailable input source." });
    }
  }
  for (const source of sources) {
    if (!source.available && !gaps.has(source.id)) {
      ctx.addIssue({ code: "custom", path: ["briefing", "unavailable_source_ids"], message: "Every unavailable input source must be disclosed." });
    }
  }
  for (const [index, item] of briefing.items.entries()) {
    if (new Set(item.source_ids).size !== item.source_ids.length) {
      ctx.addIssue({ code: "custom", path: ["briefing", "items", index, "source_ids"], message: "Item source references must be unique." });
    }
    for (const id of item.source_ids) {
      if (byId.get(id)?.available !== true) {
        ctx.addIssue({ code: "custom", path: ["briefing", "items", index, "source_ids"], message: "Items may reference only available input sources." });
      }
    }
  }
});

export function validatePersonalBriefing(input: unknown) {
  const result = contract.safeParse(input);
  if (!result.success) {
    return {
      ok: false as const,
      error: "Personal briefing failed structural and source-reference validation.",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }
  return {
    ok: true as const,
    briefing: result.data.briefing,
    checks: ["structure", "reference_membership", "source_gap_disclosure"],
    limitation: "Checks use caller-supplied sources; they do not verify retrieval provenance, factual accuracy, completeness, or permission to act.",
  };
}

export const validatePersonalBriefingTool = tool(
  async (input) => JSON.stringify(validatePersonalBriefing(input)),
  {
    name: "validate_personal_briefing",
    description: "Validate a personal briefing's structure, references against caller-supplied source IDs, and disclosure of unavailable sources. Use after drafting and before presenting a briefing. Does not prove retrieval provenance or factual accuracy and never authorizes external actions. No network calls or persistent writes.",
    schema: inputSchema,
  },
);

registerLangChainPackage({
  category: "Agent",
  tools: { read: [validatePersonalBriefingTool] },
});
