import type { NextRequest } from "next/server";
import { z } from "zod";
import { cachedJson, createdResponse, validateBody, errorResponse } from "@/lib/api/responses";
import { listSkills, writeSkill, getSkillsDir, getSkillsDirs } from "@/lib/skills";

const createSchema = z.object({
  id: z
    .string()
    .regex(/^[\w-]+$/, "Letters, digits, and hyphens only")
    .max(80),
  content: z.string().min(1).max(200_000),
});

export function GET() {
  return cachedJson({ skills: listSkills(), skills_dir: getSkillsDir(), skills_dirs: getSkillsDirs() }, 5);
}

export async function POST(req: NextRequest) {
  if (!getSkillsDir()) return errorResponse("No writable skill repo is configured", 503);
  const parsed = await validateBody(req, createSchema);
  if (parsed instanceof Response) return parsed;
  try {
    writeSkill(parsed.id, parsed.content);
    return createdResponse({ id: parsed.id });
  } catch (err) {
    return errorResponse(String(err));
  }
}
