import type { DatabaseSync } from "node:sqlite";
import { encrypt, decryptIfNeeded } from "@/lib/crypto/envelope";

const now = () => new Date().toISOString();

export function migrateInlineApiKeysToCredentials(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT name, provider, params FROM model_configs WHERE credential_id IS NULL OR credential_id = ''",
  ).all() as Array<{ name: string; provider: string; params: string }>;
  if (rows.length === 0) return;

  const insertCred = db.prepare(
    "INSERT INTO credentials (id, type, provider, auth_method, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  const linkModel = db.prepare("UPDATE model_configs SET credential_id=?, params=?, updated_at=? WHERE name=?");
  const existsCred = db.prepare("SELECT 1 FROM credentials WHERE id=?");
  const t = now();

  for (const row of rows) {
    const params = JSON.parse(decryptIfNeeded(row.params || "{}")) as Record<string, unknown>;
    const apiKey = typeof params.api_key === "string" ? params.api_key.trim() : "";
    if (!apiKey) continue; // nothing to migrate; row stays unlinked (env-only)

    // Allocate a non-colliding id of the form `model-<provider>[-N]`.
    const base = `model-${row.provider}`;
    let id = base;
    let suffix = 2;
    while (existsCred.get(id) !== undefined) {
      id = `${base}-${suffix++}`;
    }

    const credParams: Record<string, unknown> = { api_key: apiKey };
    if (typeof params.base_url === "string" && params.base_url.trim()) credParams.base_url = params.base_url;
    if (params.extra_headers && typeof params.extra_headers === "object") credParams.extra_headers = params.extra_headers;
    insertCred.run(id, "model", row.provider, "api_key", encrypt(JSON.stringify(credParams)), t, t);

    // Strip the migrated fields from model_configs.params so reads don't
    // see two competing sources of truth for the same secret.
    const cleaned: Record<string, unknown> = { ...params };
    delete cleaned.api_key;
    delete cleaned.base_url;
    delete cleaned.extra_headers;
    linkModel.run(id, encrypt(JSON.stringify(cleaned)), t, row.name);
  }
}

export function migrateIntegrationsToCredentials(db: DatabaseSync): void {
  const rows = db.prepare(
    "SELECT key, value FROM memory_store WHERE namespace='integrations'",
  ).all() as Array<{ key: string; value: string }>;
  if (rows.length === 0) return;

  const existsCred = db.prepare("SELECT 1 FROM credentials WHERE id=?");
  const insertCred = db.prepare(
    "INSERT INTO credentials (id, type, provider, auth_method, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  const t = now();

  for (const row of rows) {
    const id = `integration-${row.key}`;
    if (existsCred.get(id) !== undefined) continue;

    const params = JSON.parse(decryptIfNeeded(row.value)) as Record<string, unknown>;
    if (!params || typeof params !== "object" || Object.keys(params).length === 0) continue;

    const hasClientId = typeof params.client_id === "string" && params.client_id.length > 0;
    const hasClientSecret = typeof params.client_secret === "string" && params.client_secret.length > 0;
    const auth_method = hasClientId && hasClientSecret ? "oauth" : "api_key";

    insertCred.run(id, "integration", row.key, auth_method, encrypt(JSON.stringify(params)), t, t);
  }
}
