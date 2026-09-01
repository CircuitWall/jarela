import { getDb } from "@/lib/db";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import type { ProviderParams } from "@/lib/providers/types";
import { getCredential, getCredentialParams } from "@/lib/stores/credentials";

const now = () => new Date().toISOString();

export interface ModelConfigRow {
  name: string; provider: string; model_id: string;
  params: string; is_default: number;
  // ADR forthcoming ??? first-class credentials. NULL until the row is
  // explicitly bound (or until the auto-migration in lib/db/migrations.ts
  // lifts an inline api_key into a credential row).
  credential_id?: string | null;
  created_at: string; updated_at: string;
}

// `params` holds the provider API key alongside hyperparameters and is
// stored encrypted at rest (ADR-0005). Decrypt before returning rows.
function decryptRow<T extends { params: string }>(row: T): T {
  return { ...row, params: decryptIfNeeded(row.params) };
}

export function listModelConfigs(): ModelConfigRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM model_configs ORDER BY is_default DESC, name ASC")
    .all() as unknown as ModelConfigRow[];
  return rows.map(decryptRow);
}

export function getModelConfig(name: string): ModelConfigRow | null {
  const row = (getDb().prepare("SELECT * FROM model_configs WHERE name=?").get(name) as unknown as ModelConfigRow) ?? null;
  return row ? decryptRow(row) : null;
}

export function getDefaultModelConfig(): ModelConfigRow | null {
  const db = getDb();
  const row = (db.prepare("SELECT * FROM model_configs WHERE is_default=1 LIMIT 1").get() as unknown as ModelConfigRow) ?? null;
  if (row) return decryptRow(row);
  const fallback = (db.prepare("SELECT * FROM model_configs ORDER BY name ASC LIMIT 1").get() as unknown as ModelConfigRow) ?? null;
  return fallback ? decryptRow(fallback) : null;
}

export function upsertModelConfig(
  name: string, provider: string, model_id: string,
  params: Record<string, unknown>, is_default: boolean,
  credential_id: string | null = null,
): ModelConfigRow {
  const t = now();
  const existing = getModelConfig(name);
  const created_at = existing?.created_at ?? t;
  const finalCredId = credential_id ?? existing?.credential_id ?? null;
  // Merge onto the existing inline params rather than replacing them
  // wholesale: the Models panel form only round-trips the fields it
  // renders (api_key, base_url, extra_headers, temperature, max_tokens,
  // context_window_tokens), so a plain overwrite silently deletes any
  // other field a custom provider relies on (e.g. custom-provider.js's
  // username/password auth) on every save.
  const mergedParams = { ...decodeInlineParams(existing), ...params };
  const db = getDb();
  if (is_default) db.prepare("UPDATE model_configs SET is_default=0").run();
  db.prepare(
    "INSERT OR REPLACE INTO model_configs (name,provider,model_id,params,is_default,credential_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(name, provider, model_id, encrypt(JSON.stringify(mergedParams)), is_default ? 1 : 0, finalCredId, created_at, t);
  return getModelConfig(name)!;
}

export function deleteModelConfig(name: string): boolean {
  const db = getDb();
  const wasDefault = !!(db.prepare("SELECT is_default FROM model_configs WHERE name=?").get(name) as { is_default?: number } | undefined)?.is_default;
  const deleted = (db.prepare("DELETE FROM model_configs WHERE name=?").run(name) as { changes: number }).changes > 0;
  if (!deleted) return false;
  // Avoid the "no default" state: if the deleted row was the default and any
  // other rows remain, promote the alphabetically-first remaining row so
  // agents that fall back to the default keep working.
  if (wasDefault) {
    const next = db.prepare("SELECT name FROM model_configs ORDER BY name ASC LIMIT 1").get() as { name?: string } | undefined;
    if (next?.name) db.prepare("UPDATE model_configs SET is_default=1 WHERE name=?").run(next.name);
  }
  return true;
}

/**
 * Decode the JSON-encoded provider params (api_key, model overrides, etc.).
 * Returns an empty object on NULL/blank/malformed JSON.
 *
 * If the row carries `credential_id`, the credential's params (api_key,
 * base_url, extra_headers, OAuth tokens) are merged UNDER the row's
 * inline params, so per-model overrides still win when both sides
 * define the same key.
 */
export function getModelParams(cfg: Pick<ModelConfigRow, "params"> & Partial<Pick<ModelConfigRow, "credential_id">> | null | undefined): ProviderParams {
  const inline = decodeInlineParams(cfg);
  const credId = cfg && "credential_id" in cfg ? cfg.credential_id : null;
  if (!credId) return inline;
  const cred = getCredential(credId);
  if (!cred) return inline;
  return { ...getCredentialParams(cred), ...inline } as ProviderParams;
}

function decodeInlineParams(cfg: Pick<ModelConfigRow, "params"> | null | undefined): ProviderParams {
  if (!cfg?.params) return {};
  try {
    const parsed = JSON.parse(cfg.params);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProviderParams;
    }
    return {};
  } catch {
    return {};
  }
}
