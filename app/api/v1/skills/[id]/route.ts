import type { NextRequest } from "next/server";
import { z } from "zod";
import { NextResponse } from "next/server";
import { cachedJson, validateBody, errorResponse, notFoundResponse } from "@/lib/api/responses";
import { getSkill, writeSkill, deleteSkill, getSkillsDir } from "@/lib/skills";

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  content: z.string().min(1).max(200_000),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const skill = getSkill(id);
  if (!skill) return notFoundResponse(`Skill "${id}" not found`);
  return cachedJson(skill, 5);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getSkillsDir()) return errorResponse("No writable skill repo is configured", 503);
  const parsed = await validateBody(req, updateSchema);
  if (parsed instanceof Response) return parsed;
  try {
    writeSkill(id, parsed.content);
    return NextResponse.json({ id });
  } catch (err) {
    return errorResponse(String(err));
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!getSkillsDir()) return errorResponse("No writable skill repo is configured", 503);
  const deleted = deleteSkill(id);
  if (!deleted) return notFoundResponse(`Skill "${id}" not found`);
  return new NextResponse(null, { status: 204 });
}
