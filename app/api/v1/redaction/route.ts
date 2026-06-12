/**
 * @public — `GET/PATCH /api/v1/redaction`
 *
 * GET returns the current redaction state for the settings UI:
 *   {
 *     enabled: boolean,
 *     config_path: string,        // ~/.jarela/redaction-patterns.json
 *     config_exists: boolean,     // false until user has materialized it
 *     defaults: RedactionConfig,  // baked-in defaults the app uses if no file
 *     active: RedactionConfig,    // what's actually loaded right now
 *   }
 *
 * PATCH body:    `{ enabled: boolean }`
 * PATCH returns: `{ enabled: boolean }`
 */

import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  isRedactionEnabled,
  setRedactionEnabled,
} from "@/lib/stores/app-settings";
import {
  DEFAULT_REDACTION_CONFIG,
  getRedactionConfigPath,
  loadRedactionConfig,
} from "@/lib/redaction/patterns";

const PatchBody = z.object({
  enabled: z.boolean(),
});

export function GET(_req: Request) {
  getDb();
  const path = getRedactionConfigPath();
  return NextResponse.json({
    enabled: isRedactionEnabled(),
    config_path: path,
    config_exists: existsSync(path),
    defaults: DEFAULT_REDACTION_CONFIG,
    active: loadRedactionConfig(),
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
  if (!parsed.success) {
    return NextResponse.json({ error: "bad-body" }, { status: 400 });
  }
  setRedactionEnabled(parsed.data.enabled);
  return NextResponse.json({ enabled: isRedactionEnabled() });
}
