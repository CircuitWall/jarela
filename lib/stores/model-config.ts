import { getDb } from "@/lib/db";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";
import type { ProviderParams } from "@/lib/providers/types";
import { getCredential, getCredentialParams } from "@/lib/stores/credentials";
import { withDbTransaction } from "@/lib/db/transaction";
import { withKeyedMutation } from "@/lib/utils/keyed-mutation";

const now = () => new Date().toISOString();

export function withModelConfigMutation<T>(
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  return withKeyedMutation(`model-config:${name}`, operation);
}

export interface ModelConfigRow {
  name: string; provider: string; model_id: string;
  params: string; is_default: number;
  // ADR-0102: 0 hides the config from model selection, routing, and the
  // default fallback without deleting it. Optional for rows built in tests.
  enabled?: number;
  // ADR forthcoming ??? first-class credentials. NULL until the row is
  // explicitly bound (or until the auto-migration in lib/db/migrations.ts
  // lifts an inline api_key into a credential row).
  credential_id?: string | null;
  created_at: string; updated_at: string;
}

export class ModelConfigStateError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

export function isModelConfigEnabled(cfg: Pick<ModelConfigRow, "enabled"> | null | undefined): boolean {
  return !!cfg && cfg.enabled !== 0;
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

/** Model configs that may be offered for selection or routing. */
export function listEnabledModelConfigs(): ModelConfigRow[] {
  return listModelConfigs().filter(isModelConfigEnabled);
}

export function getModelConfig(name: string): ModelConfigRow | null {
  const row = (getDb().prepare("SELECT * FROM model_configs WHERE name=?").get(name) as unknown as ModelConfigRow) ?? null;
  return row ? decryptRow(row) : null;
}

export function getDefaultModelConfig(): ModelConfigRow | null {
  const db = getDb();
  const row = (db.prepare("SELECT * FROM model_configs WHERE is_default=1 AND enabled=1 LIMIT 1").get() as unknown as ModelConfigRow) ?? null;
  if (row) return decryptRow(row);
  const fallback = (db.prepare("SELECT * FROM model_configs WHERE enabled=1 ORDER BY name ASC LIMIT 1").get() as unknown as ModelConfigRow) ?? null;
  return fallback ? decryptRow(fallback) : null;
}

/**
 * Resolve the config a run should use: the named config when it exists and is
 * enabled, otherwise the workspace default. A disabled assignment therefore
 * falls back without being cleared, so re-enabling restores it.
 */
export function resolveRunnableModelConfig(name: string | null | undefined): ModelConfigRow | null {
  const named = name ? getModelConfig(name) : null;
  if (named && isModelConfigEnabled(named)) return named;
  return getDefaultModelConfig();
}

/** Atomically make `name` the only default model config. */
export function setDefaultModelConfig(name: string): ModelConfigRow {
  return withDbTransaction(() => {
    const db = getDb();
    const target = getModelConfig(name);
    if (!target) throw new ModelConfigStateError(`Model config "${name}" not found`, 404);
    if (!isModelConfigEnabled(target)) {
      throw new ModelConfigStateError(`Model config "${name}" is disabled; enable it before making it the default`, 409);
    }
    const t = now();
    db.prepare("UPDATE model_configs SET is_default=0, updated_at=? WHERE is_default=1 AND name<>?").run(t, name);
    db.prepare("UPDATE model_configs SET is_default=1, updated_at=? WHERE name=?").run(t, name);
    return getModelConfig(name)!;
  });
}

/**
 * Enable or disable a model config. Disabling the default promotes the
 * alphabetically-first other enabled config in the same transaction, and the
 * last enabled config cannot be disabled so runs always have a model.
 */
export function setModelConfigEnabled(name: string, enabled: boolean): ModelConfigRow {
  return withDbTransaction(() => {
    const db = getDb();
    const target = getModelConfig(name);
    if (!target) throw new ModelConfigStateError(`Model config "${name}" not found`, 404);
    if (isModelConfigEnabled(target) === enabled) return target;
    const t = now();
    if (enabled) {
      db.prepare("UPDATE model_configs SET enabled=1, updated_at=? WHERE name=?").run(t, name);
      return getModelConfig(name)!;
    }
    const next = db.prepare(
      "SELECT name FROM model_configs WHERE enabled=1 AND name<>? ORDER BY name ASC LIMIT 1",
    ).get(name) as { name?: string } | undefined;
    if (!next?.name) {
      throw new ModelConfigStateError("At least one model config must stay enabled", 409);
    }
    db.prepare("UPDATE model_configs SET enabled=0, is_default=0, updated_at=? WHERE name=?").run(t, name);
    if (target.is_default === 1) {
      db.prepare("UPDATE model_configs SET is_default=1, updated_at=? WHERE name=?").run(t, next.name);
    }
    return getModelConfig(name)!;
  });
}

/**
 * Insert or update a model config. `is_default` undefined keeps the current
 * flag (false for new rows); true atomically clears every other default and
 * re-enables the row, because the default must always be selectable.
 */
export function upsertModelConfig(
  name: string, provider: string, model_id: string,
  params: Record<string, unknown>, is_default: boolean | undefined,
  credential_id: string | null = null,
): ModelConfigRow {
  return withDbTransaction(() => {
    const db = getDb();
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
    const hasOtherEnabledDefault = !!db.prepare(
      "SELECT 1 FROM model_configs WHERE is_default=1 AND enabled=1 AND name<>? LIMIT 1",
    ).get(name);
    const finalDefault = (is_default ?? existing?.is_default === 1) || !hasOtherEnabledDefault;
    const finalEnabled = finalDefault || !existing || isModelConfigEnabled(existing);
    if (finalDefault) db.prepare("UPDATE model_configs SET is_default=0 WHERE name<>?").run(name);
    db.prepare(
      "INSERT OR REPLACE INTO model_configs (name,provider,model_id,params,is_default,enabled,credential_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(name, provider, model_id, encrypt(JSON.stringify(mergedParams)), finalDefault ? 1 : 0, finalEnabled ? 1 : 0, finalCredId, created_at, t);
    return getModelConfig(name)!;
  });
}

export function deleteModelConfig(name: string): boolean {
  return withDbTransaction(() => {
    const db = getDb();
    const wasDefault = !!(db.prepare("SELECT is_default FROM model_configs WHERE name=?").get(name) as { is_default?: number } | undefined)?.is_default;
    const deleted = (db.prepare("DELETE FROM model_configs WHERE name=?").run(name) as { changes: number }).changes > 0;
    if (!deleted) return false;
    // Automatically reset any agent pointing to this deleted model config to NULL (automatic / default model)
    db.prepare("UPDATE agent_configs SET model_config_name = NULL WHERE model_config_name = ?").run(name);
    // Repair legacy no-default states as well as promoting after default deletion.
    const hasEnabledDefault = db.prepare(
      "SELECT 1 FROM model_configs WHERE is_default=1 AND enabled=1 LIMIT 1",
    ).get();
    if (wasDefault || !hasEnabledDefault) {
      db.prepare("UPDATE model_configs SET is_default=0 WHERE is_default=1").run();
      const next = db.prepare("SELECT name FROM model_configs WHERE enabled=1 ORDER BY name ASC LIMIT 1").get() as { name?: string } | undefined;
      if (next?.name) db.prepare("UPDATE model_configs SET is_default=1 WHERE name=?").run(next.name);
    }
    return true;
  });
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
