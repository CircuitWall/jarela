import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StructuredMemoryInputSchema } from "@/lib/memory/record";
import { planMemoryCleanup } from "@/lib/skills/builtins/memory-organization/scripts/plan-cleanup.mjs";
import { registerLangChainPackage } from "../packages/langchain-package";

const inputSchema = z.object({
  now: z.string().datetime().describe("Explicit current UTC time used for expiry comparisons."),
  entries: z.array(StructuredMemoryInputSchema.pick({
    kind: true, subject: true, content: true, status: true, expires_at: true,
  }).extend({ key: z.string().trim().min(1).max(200) })).max(100)
    .describe("Projections of already retrieved facts records. Never include protected settings or secrets."),
});

export const planMemoryCleanupTool = tool(
  async (input) => JSON.stringify(planMemoryCleanup(input)),
  {
    name: "plan_memory_cleanup",
    description: "Compute expired active facts and exact kind/subject/content/expiry duplicate candidates from up to 100 supplied fact projections at an explicit UTC time. Read-only, no database access or mutation; results cover supplied entries only, not a complete scan. Review full records, provenance and confidence before any separately authorized archival. Does not perform semantic merging, deletion or grant approvals.",
    schema: inputSchema,
  },
);

registerLangChainPackage({ category: "Memory", tools: { read: [planMemoryCleanupTool] } });
