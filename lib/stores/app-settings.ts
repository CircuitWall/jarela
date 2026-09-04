import { getDb } from "@/lib/db";

const now = () => new Date().toISOString();

const NS = "app-settings";
const EMBEDDING_MODEL_KEY = "embedding_model_config";
const IDLE_TIMEOUT_KEY = "screen_lock_idle_timeout_ms";
const REDACTION_ENABLED_KEY = "redaction_enabled";
const ARTIFACT_LIFECYCLE_KEY = "artifact_lifecycle";

export interface ArtifactLifecycleSettings {
  retention_days: number;
  max_total_mb: number;
  include_browser_artifacts: boolean;
  include_generated_media: boolean;
}

export const DEFAULT_ARTIFACT_LIFECYCLE_SETTINGS: ArtifactLifecycleSettings = {
  retention_days: 30,
  max_total_mb: 512,
  include_browser_artifacts: true,
  include_generated_media: true,
};

function readJsonSetting<T>(key: string): T | null {
  const row = getDb()
    .prepare("SELECT value FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, key) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function writeJsonSetting(key: string, value: unknown): void {
  const existing = getDb()
    .prepare("SELECT created_at FROM memory_store WHERE namespace=? AND key=?")
    .get(NS, key) as { created_at?: string } | undefined;
  const t = now();
  const created = existing?.created_at ?? t;
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO memory_store (namespace,key,value,created_at,updated_at,embedding) VALUES (?,?,?,?,?,NULL)",
    )
    .run(NS, key, JSON.stringify(value), created, t);
}

export function getEmbeddingModelConfigName(): string | null {
  const parsed = readJsonSetting<unknown>(EMBEDDING_MODEL_KEY);
  return typeof parsed === "string" && parsed.trim() ? parsed : null;
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
  writeJsonSetting(IDLE_TIMEOUT_KEY, ms);
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
  writeJsonSetting(REDACTION_ENABLED_KEY, Boolean(enabled));
}

export function getArtifactLifecycleSettings(): ArtifactLifecycleSettings {
  const raw = readJsonSetting<Partial<ArtifactLifecycleSettings>>(ARTIFACT_LIFECYCLE_KEY);
  return normalizeArtifactLifecycleSettings(raw ?? {});
}

export function setArtifactLifecycleSettings(input: Partial<ArtifactLifecycleSettings>): ArtifactLifecycleSettings {
  const next = normalizeArtifactLifecycleSettings({
    ...getArtifactLifecycleSettings(),
    ...input,
  });
  writeJsonSetting(ARTIFACT_LIFECYCLE_KEY, next);
  return next;
}

function normalizeArtifactLifecycleSettings(input: Partial<ArtifactLifecycleSettings>): ArtifactLifecycleSettings {
  const retention = Number(input.retention_days);
  const maxMb = Number(input.max_total_mb);
  return {
    retention_days: Number.isFinite(retention) ? Math.max(1, Math.min(365, Math.floor(retention))) : DEFAULT_ARTIFACT_LIFECYCLE_SETTINGS.retention_days,
    max_total_mb: Number.isFinite(maxMb) ? Math.max(16, Math.min(10240, Math.floor(maxMb))) : DEFAULT_ARTIFACT_LIFECYCLE_SETTINGS.max_total_mb,
    include_browser_artifacts: input.include_browser_artifacts !== false,
    include_generated_media: input.include_generated_media !== false,
  };
}

