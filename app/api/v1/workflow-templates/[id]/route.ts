import { NextRequest } from "next/server";
import { resolveSkill } from "@/lib/skills";
import { readSkillTextFile } from "@/lib/skills/bundle-files";
import { parseWorkflowDefinition } from "@/lib/workflows/definition";
import { localExecutionGuard } from "@/lib/api/local-execution-guard";
import { errorResponse, noStoreJson } from "@/lib/api/responses";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const refused = localExecutionGuard(req);
  if (refused) return refused;
  try {
    const skill = resolveSkill((await context.params).id);
    if (!skill?.directory) return errorResponse("Skill has no workflow bundle", 404);
    const definitionText = readSkillTextFile(skill.directory, "workflow.json", 65536).content;
    return noStoreJson({ definitionText, revision: parseWorkflowDefinition(definitionText).revision });
  } catch (error) { return errorResponse(error instanceof Error ? error.message : "Workflow template unavailable", 400); }
}
