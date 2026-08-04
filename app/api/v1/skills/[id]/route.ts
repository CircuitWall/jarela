import type { NextRequest } from "next/server";
import { z } from "zod";
import { NextResponse } from "next/server";
import { cachedJson, validateBody, errorResponse, notFoundResponse } from "@/lib/api/responses";
import { getSkill, writeSkill, deleteSkill, getSkillsDir } from "@/lib/skills";

const updateSchema = z.object({
  content: z.string().min(1).max(200_000),
});

export function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!getSkillsDir()) return errorResponse("JARELA_SKILLS_DIR is not configured", 503);
  const skill = getSkill(params.id);
  if (!skill) return notFoundResponse(`Skill "${params.id}" not found`);
  return cachedJson(skill, 5);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  if (!getSkillsDir()) return errorResponse("JARELA_SKILLS_DIR is not configured", 503);
  const parsed = await validateBody(req, updateSchema);
  if (parsed instanceof Response) return parsed;
  try {
    writeSkill(params.id, parsed.content);
    return NextResponse.json({ id: params.id });
  } catch (err) {
    return errorResponse(String(err));
  }
}

export function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!getSkillsDir()) return errorResponse("JARELA_SKILLS_DIR is not configured", 503);
  const deleted = deleteSkill(params.id);
  if (!deleted) return notFoundResponse(`Skill "${params.id}" not found`);
  return new NextResponse(null, { status: 204 });
}
