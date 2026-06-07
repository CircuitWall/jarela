/**
 * @public — `GET /api/v1/credentials` (list), `POST /api/v1/credentials` (create)
 *
 * Typed-credentials surface. Each credential row carries a `type`
 * (`model` today; `tts` / `integration` / `bridge` later), a `provider`,
 * an `auth_method` (`api_key` | `oauth`), and an encrypted `params`
 * blob. Model configs reference credentials by `credential_id` rather
 * than carrying inline api_key fields.
 *
 * Secret fields (`api_key`, `api_token`, `client_secret`,
 * `refresh_token`, `access_token`, `token`, `password`, `secret`) are
 * redacted to `"***"` in every read response so a compromised client
 * never sees plaintext. See `SECRET_PARAM_KEYS` in
 * `lib/stores/credentials.ts` for the authoritative list.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createCredential, listCredentials, SECRET_PARAM_KEYS, type CredentialAuthMethod, type CredentialRow, type CredentialType } from "@/lib/stores/credentials";
import { errorResponse, cachedJson, createdResponse } from "@/lib/api/responses";
import { parseJsonSafe } from "@/lib/utils/json";
const VALID_TYPES = new Set<CredentialType>(["model", "tts", "integration", "bridge"]);
const VALID_AUTH = new Set<CredentialAuthMethod>(["api_key", "oauth"]);

function publicView(row: CredentialRow) {
  const params = parseJsonSafe<Record<string, unknown>>(row.params, {});
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_PARAM_KEYS.has(k)) {
      // Preserve presence (so the UI can render "configured" badges)
      // without leaking the cleartext.
      safe[k] = typeof v === "string" && v.length > 0 ? "***" : v;
    } else {
      safe[k] = v;
    }
  }
  return { ...row, params: safe };
}

export function GET(req: NextRequest) {
  const url = req.nextUrl;
  const type = url.searchParams.get("type") as CredentialType | null;
  const provider = url.searchParams.get("provider");
  if (type && !VALID_TYPES.has(type)) return errorResponse("invalid type filter");
  const rows = listCredentials({
    type: type ?? undefined,
    provider: provider ?? undefined,
  });
  return cachedJson(rows.map(publicView), 5);
}

const CreateBody = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(["model", "tts", "integration", "bridge"]),
  provider: z.string().min(1),
  auth_method: z.enum(["api_key", "oauth"]).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.message);
  const { id, type, provider, auth_method, params } = parsed.data;
  if (auth_method && !VALID_AUTH.has(auth_method)) return errorResponse("invalid auth_method");
  const row = createCredential({ id, type, provider, auth_method, params });
  return createdResponse(publicView(row));
}
