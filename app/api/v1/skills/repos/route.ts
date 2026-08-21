import type { NextRequest } from "next/server";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { cachedJson, createdResponse, validateBody, errorResponse } from "@/lib/api/responses";
import { createSkillRepo, getSkillRepoByPath, listSkillRepos, type SkillRepoRow } from "@/lib/stores/skill-repos";

const createSchema = z.object({
  path: z.string().min(1),
  label: z.string().nullable().optional(),
  writable: z.boolean().optional(),
});

function rowResponse(row: SkillRepoRow) {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    writable: row.writable === 1,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function GET() {
  return cachedJson({ repos: listSkillRepos().map(rowResponse) }, 5);
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
  return createdResponse(rowResponse(row));
}
