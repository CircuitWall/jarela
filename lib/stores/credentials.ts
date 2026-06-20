import { getDb } from "@/lib/db";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";

const now = () => new Date().toISOString();

// Domains a credential can belong to. `model` covers LLM provider creds
// today; `tts`, `integration`, `bridge` slot in later without a schema
// change.
export type CredentialType = "model" | "tts" | "integration" | "bridge";

// `api_key` flattens straight into ProviderParams at call time; `oauth`
// carries refresh/access tokens that the provider adapter exchanges.
export type CredentialAuthMethod = "api_key" | "oauth";

export interface CredentialRow {
  id: string;
  type: CredentialType;
  provider: string;
  auth_method: CredentialAuthMethod;
  // Human-readable name shown in the UI ("Work", "Personal", …). NULL =
  // fall back to `id` in the renderer. Multiple credentials may share a
  // label — uniqueness is on `id` only.
  label: string | null;
  // 1 = the implicit pick for callers that don't reference a specific
  // credential id (back-compat with the legacy single-instance flows).
  // Exactly one row per (type, provider) carries 1; the store layer
  // enforces this on every write.
  is_default: number;
  params: string; // decrypted JSON string
  created_at: string;
  updated_at: string;
}

export interface CredentialParams {
  api_key?: string;
  base_url?: string;
  extra_headers?: Record<string, string>;
  // OAuth shape — populated for auth_method === "oauth"
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  access_token?: string;
  expires_at?: string;
  [k: string]: unknown;
}

// Param keys that hold a secret and must be redacted from any
// outbound API response. Kept in sync with the `secret: true` fields
// of every integration manifest in `lib/stores/integrations.ts` —
// missing a name here means the secret leaks in plaintext via
// `GET /api/v1/credentials`.
export const SECRET_PARAM_KEYS: ReadonlySet<string> = new Set([
  "api_key",
  "api_token",
  "app_password",
  "client_secret",
  "refresh_token",
  "access_token",
  "token",
  "password",
  "secret",
]);

function decryptRow<T extends { params: string }>(row: T): T {
  return { ...row, params: decryptIfNeeded(row.params) };
}

export function listCredentials(filter?: { type?: CredentialType; provider?: string }): CredentialRow[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (filter?.type) { clauses.push("type=?"); args.push(filter.type); }
  if (filter?.provider) { clauses.push("provider=?"); args.push(filter.provider); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM credentials ${where} ORDER BY type, provider, is_default DESC, id`)
    .all(...args) as unknown as CredentialRow[];
  return rows.map(decryptRow);
}

export function getCredential(id: string): CredentialRow | null {
  const row = (getDb().prepare("SELECT * FROM credentials WHERE id=?").get(id) as unknown as CredentialRow) ?? null;
  return row ? decryptRow(row) : null;
}

// Returns the credential currently flagged as the default for the given
// (type, provider). When none is explicitly flagged (legacy rows on a
// fresh install before the seed kicks in), returns the lowest-id row.
export function getDefaultCredential(type: CredentialType, provider: string): CredentialRow | null {
  const rows = listCredentials({ type, provider });
  if (rows.length === 0) return null;
  return rows.find((r) => r.is_default === 1) ?? rows[0];
}

// Generates a stable id of the form `<type>-<provider>` (bumped with `-N`
// on collision) so the default-name UX matches the user's spec without
// requiring uniqueness in the panel.
export function nextCredentialId(type: CredentialType, provider: string): string {
  const base = `${type}-${provider}`;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM credentials WHERE id=?").get(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!db.prepare("SELECT 1 FROM credentials WHERE id=?").get(candidate)) return candidate;
  }
  throw new Error(`Cannot allocate credential id for ${base}: too many existing rows`);
}

export interface CreateCredentialInput {
  // When omitted, an id is allocated via nextCredentialId().
  id?: string;
  type: CredentialType;
  provider: string;
  auth_method?: CredentialAuthMethod;
  label?: string | null;
  // When true the new row becomes the default for its (type, provider) pair
  // and any sibling rows are cleared. Auto-true for the first row of a
  // pair regardless of the caller's value.
  is_default?: boolean;
  params?: CredentialParams;
}

export function createCredential(input: CreateCredentialInput): CredentialRow {
  const t = now();
  const id = (input.id?.trim() || nextCredentialId(input.type, input.provider)).trim();
  const auth_method: CredentialAuthMethod = input.auth_method ?? "api_key";
  const params = input.params ?? {};
  const db = getDb();
  const existingForPair = db
    .prepare("SELECT id FROM credentials WHERE type=? AND provider=? LIMIT 1")
    .get(input.type, input.provider) as { id?: string } | undefined;
  const isDefault = existingForPair === undefined ? true : (input.is_default ?? false);
  // When the caller didn't supply a label, derive a friendly default —
  // "Default" for the first row of a (type, provider) pair so the
  // legacy single-credential install renders with a clear name in the
  // panel, otherwise leave NULL and the UI falls back to the id.
  const requested = normaliseLabel(input.label);
  const label = requested ?? (existingForPair === undefined ? "Default" : null);
  db.prepare(
    "INSERT INTO credentials (id, type, provider, auth_method, label, is_default, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    input.type,
    input.provider,
    auth_method,
    label,
    isDefault ? 1 : 0,
    encrypt(JSON.stringify(params)),
    t,
    t,
  );
  if (isDefault) clearDefaultsExcept(input.type, input.provider, id);
  return getCredential(id)!;
}

export interface UpdateCredentialInput {
  provider?: string;
  auth_method?: CredentialAuthMethod;
  label?: string | null;
  is_default?: boolean;
  params?: CredentialParams;
}

export function updateCredential(id: string, patch: UpdateCredentialInput): CredentialRow | null {
  const existing = getCredential(id);
  if (!existing) return null;
  const provider = patch.provider ?? existing.provider;
  const auth_method = patch.auth_method ?? existing.auth_method;
  const nextParams = patch.params ?? getCredentialParams(existing);
  const label = patch.label === undefined ? existing.label : normaliseLabel(patch.label);
  const isDefault = patch.is_default === undefined ? existing.is_default === 1 : patch.is_default;
  getDb()
    .prepare(
      "UPDATE credentials SET provider=?, auth_method=?, label=?, is_default=?, params=?, updated_at=? WHERE id=?",
    )
    .run(provider, auth_method, label, isDefault ? 1 : 0, encrypt(JSON.stringify(nextParams)), now(), id);
  if (isDefault) clearDefaultsExcept(existing.type, provider, id);
  return getCredential(id);
}

// Promote a credential to be the default for its (type, provider) pair.
// Idempotent. Returns the updated row or null when the id doesn't exist.
export function setDefaultCredential(id: string): CredentialRow | null {
  return updateCredential(id, { is_default: true });
}

export function deleteCredential(id: string): boolean {
  const db = getDb();
  const existing = getCredential(id);
  if (!existing) return false;
  const res = db.prepare("DELETE FROM credentials WHERE id=?").run(id) as { changes: number };
  if (res.changes === 0) return false;
  // If we just removed the default, promote any remaining sibling so callers
  // without an explicit id keep resolving cleanly.
  if (existing.is_default === 1) {
    const survivor = db
      .prepare("SELECT id FROM credentials WHERE type=? AND provider=? ORDER BY id LIMIT 1")
      .get(existing.type, existing.provider) as { id?: string } | undefined;
    if (survivor?.id) {
      db.prepare("UPDATE credentials SET is_default=1, updated_at=? WHERE id=?")
        .run(now(), survivor.id);
    }
  }
  return true;
}

export function getCredentialParams(cred: Pick<CredentialRow, "params"> | null | undefined): CredentialParams {
  if (!cred?.params) return {};
  try {
    const parsed = JSON.parse(cred.params);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CredentialParams;
    }
    return {};
  } catch {
    return {};
  }
}

// True iff any model_configs row or agent tool_credentials map still
// references this credential. Used by the delete endpoint to surface a
// friendlier "in use" error and avoid breaking running agents.
export function isCredentialReferenced(id: string): boolean {
  const db = getDb();
  const fromModel = db
    .prepare("SELECT 1 FROM model_configs WHERE credential_id=? LIMIT 1")
    .get(id) as { 1?: number } | undefined;
  if (fromModel !== undefined) return true;
  // tool_credentials is a JSON object keyed by tool name with the credential
  // id as the value. A substring LIKE match avoids deserialising every row
  // and is exact enough — ids are alphanumeric with `-` only.
  const fromAgent = db
    .prepare("SELECT 1 FROM agent_configs WHERE tool_credentials LIKE ? LIMIT 1")
    .get(`%"${id}"%`) as { 1?: number } | undefined;
  return fromAgent !== undefined;
}

function clearDefaultsExcept(type: CredentialType, provider: string, keepId: string): void {
  getDb()
    .prepare("UPDATE credentials SET is_default=0 WHERE type=? AND provider=? AND id<>? AND is_default=1")
    .run(type, provider, keepId);
}

function normaliseLabel(label: string | null | undefined): string | null {
  if (label === undefined || label === null) return null;
  const trimmed = label.trim();
  return trimmed.length === 0 ? null : trimmed;
}
