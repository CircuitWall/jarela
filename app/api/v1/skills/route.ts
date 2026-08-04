import type { NextRequest } from "next/server";
import { z } from "zod";
import { cachedJson, createdResponse, validateBody, errorResponse } from "@/lib/api/responses";
import { listSkills, writeSkill, getSkillsDir } from "@/lib/skills";

const createSchema = z.object({
  id: z
    .string()
    .regex(/^[\w-]+$/, "Letters, digits, and hyphens only")
    .max(80),
  content: z.string().min(1).max(200_000),
});

export function GET() {
  if (!getSkillsDir()) {
    return cachedJson({ skills: [], skills_dir: null }, 5);
  }
  return cachedJson({ skills: listSkills(), skills_dir: getSkillsDir() }, 5);
}

export async function POST(req: NextRequest) {
  if (!getSkillsDir()) return errorResponse("JARELA_SKILLS_DIR is not configured", 503);
  const parsed = await validateBody(req, createSchema);
  if (parsed instanceof Response) return parsed;
  try {
    writeSkill(parsed.id, parsed.content);
    return createdResponse({ id: parsed.id });
  } catch (err) {
    return errorResponse(String(err));
  }
}
