import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

export interface ModelConfigRow {
  name: string; provider: string; model_id: string;
  params: string; is_default: number;
  created_at: string; updated_at: string;
}

export function listModelConfigs(): ModelConfigRow[] {
  return getDb()
    .prepare("SELECT * FROM model_configs ORDER BY is_default DESC, name ASC")
    .all() as unknown as ModelConfigRow[];
}

export function getModelConfig(name: string): ModelConfigRow | null {
  return (getDb().prepare("SELECT * FROM model_configs WHERE name=?").get(name) as unknown as ModelConfigRow) ?? null;
}

export function getDefaultModelConfig(): ModelConfigRow | null {
  return (getDb().prepare("SELECT * FROM model_configs WHERE is_default=1 LIMIT 1").get() as unknown as ModelConfigRow) ?? null;
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
  ).run(name, provider, model_id, JSON.stringify(params), is_default ? 1 : 0, created_at, t);
  return getModelConfig(name)!;
}

export function deleteModelConfig(name: string): boolean {
  return (getDb().prepare("DELETE FROM model_configs WHERE name=?").run(name) as { changes: number }).changes > 0;
}
