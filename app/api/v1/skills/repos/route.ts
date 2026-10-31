import type { NextRequest } from "next/server";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createdResponse, validateBody, errorResponse, noStoreJson } from "@/lib/api/responses";
import { createSkillRepo, getSkillRepoByPath, listSkillRepos } from "@/lib/stores/skill-repos";
import { skillRepoToResponse } from "@/lib/api/serializers";

const createSchema = z.object({
  path: z.string().min(1),
  label: z.string().nullable().optional(),
  writable: z.boolean().optional(),
});

export function GET() {
  return noStoreJson({ repos: listSkillRepos().map(skillRepoToResponse) });
}

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, createSchema);
  if (parsed instanceof Response) return parsed;

  const abs = path.resolve(parsed.path);
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return errorResponse("path is not a directory", 400);
  } catch {
    return errorResponse("path does not exist or is unreadable", 400);
  }

  if (getSkillRepoByPath(abs)) return errorResponse("a repo already exists for this path", 409);

  const row = createSkillRepo({ path: abs, label: parsed.label ?? null, writable: parsed.writable });
  return createdResponse(skillRepoToResponse(row));
}
