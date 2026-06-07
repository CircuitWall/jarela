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
    .prepare(`SELECT * FROM credentials ${where} ORDER BY type, provider, id`)
    .all(...args) as unknown as CredentialRow[];
  return rows.map(decryptRow);
}

export function getCredential(id: string): CredentialRow | null {
  const row = (getDb().prepare("SELECT * FROM credentials WHERE id=?").get(id) as unknown as CredentialRow) ?? null;
  return row ? decryptRow(row) : null;
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
  params?: CredentialParams;
}

export function createCredential(input: CreateCredentialInput): CredentialRow {
  const t = now();
  const id = (input.id?.trim() || nextCredentialId(input.type, input.provider)).trim();
  const auth_method: CredentialAuthMethod = input.auth_method ?? "api_key";
  const params = input.params ?? {};
  getDb()
    .prepare(
      "INSERT INTO credentials (id, type, provider, auth_method, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(id, input.type, input.provider, auth_method, encrypt(JSON.stringify(params)), t, t);
  return getCredential(id)!;
}

export interface UpdateCredentialInput {
  provider?: string;
  auth_method?: CredentialAuthMethod;
  params?: CredentialParams;
}

export function updateCredential(id: string, patch: UpdateCredentialInput): CredentialRow | null {
  const existing = getCredential(id);
  if (!existing) return null;
  const provider = patch.provider ?? existing.provider;
  const auth_method = patch.auth_method ?? existing.auth_method;
  const nextParams = patch.params ?? getCredentialParams(existing);
  getDb()
    .prepare("UPDATE credentials SET provider=?, auth_method=?, params=?, updated_at=? WHERE id=?")
    .run(provider, auth_method, encrypt(JSON.stringify(nextParams)), now(), id);
  return getCredential(id);
}

export function deleteCredential(id: string): boolean {
  return (getDb().prepare("DELETE FROM credentials WHERE id=?").run(id) as { changes: number }).changes > 0;
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

// True iff any model_configs row references this credential. Used by
// the delete endpoint to surface a friendlier "in use" error.
export function isCredentialReferenced(id: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM model_configs WHERE credential_id=? LIMIT 1")
    .get(id) as { 1?: number } | undefined;
  return row !== undefined;
}
