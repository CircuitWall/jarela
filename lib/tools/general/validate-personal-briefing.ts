import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "../packages/langchain-package";
import { validatePersonalBriefing } from "@/lib/skills/builtins/personal-briefing/scripts/validate.mjs";

export { validatePersonalBriefing };

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
