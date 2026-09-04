import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { cleanupArtifactFiles, listArtifactFiles } from "@/lib/files";
import {
  getArtifactLifecycleSettings,
  setArtifactLifecycleSettings,
} from "@/lib/stores/app-settings";

const PatchBody = z.object({
  retention_days: z.number().int().min(1).max(365).optional(),
  max_total_mb: z.number().int().min(16).max(10240).optional(),
  include_browser_artifacts: z.boolean().optional(),
  include_generated_media: z.boolean().optional(),
});

const CleanupBody = z.object({
  dry_run: z.boolean().optional(),
});

export function GET(_req: Request) {
  getDb();
  return NextResponse.json({
    settings: getArtifactLifecycleSettings(),
    inventory: listArtifactFiles(),
  });
}

export async function PATCH(req: Request) {
  getDb();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  return NextResponse.json({
    settings: setArtifactLifecycleSettings(parsed.data),
    inventory: listArtifactFiles(),
  });
}

export async function POST(req: Request) {
  getDb();
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = CleanupBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const settings = getArtifactLifecycleSettings();
  const result = cleanupArtifactFiles(settings, parsed.data.dry_run ?? false);
  return NextResponse.json({ settings, result });
}
