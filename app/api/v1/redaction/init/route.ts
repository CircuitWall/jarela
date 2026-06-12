/**
 * @public — `POST /api/v1/redaction/init`
 *
 * Materializes ~/.jarela/redaction-patterns.json on disk by writing the
 * baked-in defaults. Idempotent — if the file already exists, returns
 * the path without overwriting (so user edits are never clobbered).
 *
 * Returns: `{ path: string, created: boolean }`
 */

import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { getDb } from "@/lib/db";
import {
  ensureRedactionConfigFile,
  getRedactionConfigPath,
} from "@/lib/redaction/patterns";

export function POST(_req: Request) {
  getDb();
  const path = getRedactionConfigPath();
  const existed = existsSync(path);
  ensureRedactionConfigFile();
  return NextResponse.json({ path, created: !existed });
}
