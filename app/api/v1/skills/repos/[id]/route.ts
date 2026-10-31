import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateBody, notFoundResponse } from "@/lib/api/responses";
import { deleteSkillRepo, getSkillRepo, updateSkillRepo } from "@/lib/stores/skill-repos";
import { skillRepoToResponse } from "@/lib/api/serializers";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  label: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  writable: z.boolean().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const row = getSkillRepo(id);
  if (!row) return notFoundResponse();
  return NextResponse.json(skillRepoToResponse(row));
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const parsed = await validateBody(req, patchSchema);
  if (parsed instanceof NextResponse) return parsed;
  const row = updateSkillRepo(id, parsed);
  if (!row) return notFoundResponse();
  return NextResponse.json(skillRepoToResponse(row));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteSkillRepo(id);
  if (!ok) return notFoundResponse();
  return NextResponse.json({ deleted: true });
}
