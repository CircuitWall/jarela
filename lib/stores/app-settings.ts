import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

const NS = "app-settings";
const EMBEDDING_MODEL_KEY = "embedding_model_config";

export function getEmbeddingModelConfigName(): string | null {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, EMBEDDING_MODEL_KEY) as { value?: string } | undefined;
  const raw = row?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return null;
  }
}

export function setEmbeddingModelConfigName(name: string | null): string | null {
  if (!name) {
    getDb().prepare("DELETE FROM memory_store WHERE namespace=? AND key=?").run(NS, EMBEDDING_MODEL_KEY);
    return null;
  }
  const existing = getDb()
    .prepare("SELECT created_at FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, EMBEDDING_MODEL_KEY) as { created_at?: string } | undefined;
  const t = now();
  const created = existing?.created_at ?? t;
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)",
    )
    .run(NS, EMBEDDING_MODEL_KEY, JSON.stringify(name), created, t);
  return name;
}
