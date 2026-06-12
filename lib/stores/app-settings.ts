import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

const NS = "app-settings";
const EMBEDDING_MODEL_KEY = "embedding_model_config";
const IDLE_TIMEOUT_KEY = "screen_lock_idle_timeout_ms";
const REDACTION_ENABLED_KEY = "redaction_enabled";

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

export function getScreenLockIdleTimeoutMs(): number | null {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, IDLE_TIMEOUT_KEY) as { value?: string } | undefined;
  const raw = row?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : null;
  } catch {
    return null;
  }
}

export function setScreenLockIdleTimeoutMs(ms: number): void {
  const existing = getDb()
    .prepare("SELECT created_at FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, IDLE_TIMEOUT_KEY) as { created_at?: string } | undefined;
  const t = now();
  const created = existing?.created_at ?? t;
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)",
    )
    .run(NS, IDLE_TIMEOUT_KEY, JSON.stringify(ms), created, t);
}

// Outbound-redaction toggle (ADR-0064). Default ON: every read returns
// true unless the user has explicitly persisted false. The setting is
// global because the trust boundary it guards (what crosses to the LLM
// provider) is uniform across agents.
export function isRedactionEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, REDACTION_ENABLED_KEY) as { value?: string } | undefined;
  if (!row?.value) return true;
  try {
    return JSON.parse(row.value) !== false;
  } catch {
    return true;
  }
}

export function setRedactionEnabled(enabled: boolean): void {
  const existing = getDb()
    .prepare("SELECT created_at FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, REDACTION_ENABLED_KEY) as { created_at?: string } | undefined;
  const t = now();
  const created = existing?.created_at ?? t;
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)",
    )
    .run(NS, REDACTION_ENABLED_KEY, JSON.stringify(Boolean(enabled)), created, t);
}

