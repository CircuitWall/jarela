import { getDb } from "@/lib/db";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import type { ProviderParams } from "@/lib/providers/types";

const now = () => new Date().toISOString();

export interface ModelConfigRow {
  name: string; provider: string; model_id: string;
  params: string; is_default: number;
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
  const row = (getDb().prepare("SELECT * FROM model_configs WHERE is_default=1 LIMIT 1").get() as unknown as ModelConfigRow) ?? null;
  return row ? decryptRow(row) : null;
}

export function upsertModelConfig(
  name: string, provider: string, model_id: string,
  params: Record<string, unknown>, is_default: boolean
): ModelConfigRow {
  const t = now();
  const existing = getModelConfig(name);
  const created_at = existing?.created_at ?? t;
  const db = getDb();
  if (is_default) db.prepare("UPDATE model_configs SET is_default=0").run();
  db.prepare(
    "INSERT OR REPLACE INTO model_configs (name,provider,model_id,params,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(name, provider, model_id, encrypt(JSON.stringify(params)), is_default ? 1 : 0, created_at, t);
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
 * Returns an empty object on NULL/blank/malformed JSON. Callers that
 * previously did `JSON.parse(cfg.params)` inline should switch to this
 * getter so the serialization contract stays owned by this store.
 */
export function getModelParams(cfg: Pick<ModelConfigRow, "params"> | null | undefined): ProviderParams {
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
