/**
 * @public — `PUT /api/v1/credentials/[id]` (update), `DELETE /api/v1/credentials/[id]`
 *
 * Update merges the body's `params` into the stored params, so the
 * client can PATCH just `api_key` without resending `base_url` /
 * `extra_headers`. Secret fields posted as `"***"` are treated as
 * "keep existing" so a round-trip from the redacted GET doesn't blank
 * the stored secret.
 *
 * Delete refuses when any model_config still references the credential
 * — caller must rebind those models first.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteCredential,
  getCredential,
  getCredentialParams,
  isCredentialReferenced,
  SECRET_PARAM_KEYS,
  updateCredential,
} from "@/lib/stores/credentials";
import { errorResponse } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";

type Params = { params: Promise<{ id: string }> };

const UpdateBody = z.object({
  provider: z.string().min(1).optional(),
  auth_method: z.enum(["api_key", "oauth"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

function publicView(row: ReturnType<typeof getCredential>) {
  if (!row) return null;
  const params = parseJsonSafe<Record<string, unknown>>(row.params, {});
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_PARAM_KEYS.has(k)) safe[k] = typeof v === "string" && v.length > 0 ? "***" : v;
    else safe[k] = v;
  }
  return { ...row, params: safe };
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = getCredential(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = UpdateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.message);

  // Merge body params with the stored params, treating "***" as
  // "keep existing" so a redacted round-trip is safe.
  const stored = getCredentialParams(existing);
  const merged: Record<string, unknown> = { ...stored };
  if (parsed.data.params) {
    for (const [k, v] of Object.entries(parsed.data.params)) {
      if (SECRET_PARAM_KEYS.has(k) && v === "***") continue;
      merged[k] = v;
    }
  }
  const next = updateCredential(id, {
    provider: parsed.data.provider,
    auth_method: parsed.data.auth_method,
    params: merged,
  });
  return NextResponse.json(publicView(next));
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  if (isCredentialReferenced(id)) {
    return NextResponse.json(
      { error: "Credential is in use; rebind dependent models first.", code: "in_use" },
      { status: 409 },
    );
  }
  const deleted = deleteCredential(id);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
