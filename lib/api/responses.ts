// Shared HTTP response builders for app/api/v1/** route handlers.
//
// Goal: every error/success payload across the v1 surface has the same
// shape. Before this lived inline, response bodies drifted —
// `{error: "x"}` vs `{message: "x"}`, 400 vs 422 for the same condition,
// some routes returned Zod's raw issue array, others stringified it.

import { NextResponse } from "next/server";
import type { z } from "zod";
import type { NextRequest } from "next/server";

// ADR-0053 — error envelope now carries an optional `code` so the client can
// branch on failure class without parsing the message string. Existing
// `{error: message}` shape is preserved; `code` is purely additive.
export function errorResponse(message: string, status: number = 400, code?: string): NextResponse {
  const body: { error: string; code?: string } = { error: message };
  if (code) body.code = code;
  return NextResponse.json(body, { status });
}

export function notFoundResponse(message: string = "Not found", code: string = "not_found"): NextResponse {
  return errorResponse(message, 404, code);
}

export function createdResponse<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

// Wrap a 200 JSON response with a private Cache-Control header. Use on safe
// GET endpoints that serve user-scoped data the client refetches often (panel
// mounts, navigation back/forward) but mutates rarely. The TTL is short
// enough that explicit mutations — which patch the client-side ApiClient
// cache in place — stay observably consistent without an extra roundtrip.
export function cachedJson<T>(data: T, maxAgeSeconds: number): NextResponse {
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": `private, max-age=${maxAgeSeconds}`,
    },
  });
}

// Validate a JSON request body against a zod schema.
// Returns either the parsed data or a 400 NextResponse explaining the issue.
// Caller pattern:
//   const parsed = await validateBody(req, Schema);
//   if (parsed instanceof NextResponse) return parsed;
//   // use parsed.field
export async function validateBody<S extends z.ZodTypeAny>(
  req: NextRequest,
  schema: S,
): Promise<z.infer<S> | NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "invalid body", 400, "invalid_args");
  }
  return parsed.data;
}
