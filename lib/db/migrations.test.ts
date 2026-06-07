import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-cred-migrate-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Pre-seed an "inline api_key" row BEFORE the migration runs by hand-rolling
// it through the model-config store, then trigger the migration via getDb().
const { getDb } = await import("./index");
const { encrypt } = await import("@/lib/crypto/envelope");
const { upsertModelConfig, getModelConfig } = await import("@/lib/stores/model-config");
const { listCredentials, getCredentialParams } = await import("@/lib/stores/credentials");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("migrateInlineApiKeysToCredentials", () => {
  it("lifts an inline api_key into a credential row and links the model", () => {
    // Boot the db (runs all ensures + seeders + the initial migration pass).
    const db = getDb();

    // Inject a legacy-shaped row (inline api_key, no credential_id) by
    // writing directly to the table so we bypass the upsert's normalization.
    const t = new Date().toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO model_configs (name, provider, model_id, params, is_default, credential_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      "legacy-row",
      "anthropic",
      "claude-x",
      encrypt(JSON.stringify({ api_key: "sk-legacy", base_url: "https://legacy", temperature: 0.7 })),
      0,
      null,
      t,
      t,
    );

    // Re-import migrations and re-run; the helper is idempotent.
    return import("@/lib/db/migrations").then(({ runMigrations }) => {
      runMigrations(db);

      const cfg = getModelConfig("legacy-row")!;
      expect(cfg.credential_id).toBe("model-anthropic");

      const creds = listCredentials({ type: "model", provider: "anthropic" });
      const linked = creds.find((c) => c.id === "model-anthropic")!;
      expect(linked).toBeTruthy();
      expect(getCredentialParams(linked).api_key).toBe("sk-legacy");
      expect(getCredentialParams(linked).base_url).toBe("https://legacy");

      // Inline params on the model row no longer carry the secret.
      const inline = JSON.parse(cfg.params) as Record<string, unknown>;
      expect(inline.api_key).toBeUndefined();
      expect(inline.base_url).toBeUndefined();
      expect(inline.temperature).toBe(0.7);

      // Idempotent: a second run is a no-op (no extra credential rows).
      const before = listCredentials({ type: "model" }).length;
      runMigrations(db);
      expect(listCredentials({ type: "model" }).length).toBe(before);

      // upsertModelConfig preserves the linked credential_id when not overridden.
      upsertModelConfig("legacy-row", "anthropic", "claude-x", { temperature: 0.5 }, false);
      expect(getModelConfig("legacy-row")?.credential_id).toBe("model-anthropic");
    });
  });
});

describe("migrateIntegrationsToCredentials", () => {
  it("lifts memory_store integration rows into credential rows", async () => {
    const db = getDb();
    const t = new Date().toISOString();

    // Seed two legacy integration rows directly into memory_store: one
    // OAuth shape (gmail) and one api-key shape (atlassian). Memory_store
    // values are plaintext JSON — the migration encrypts them on copy.
    db.prepare(
      "INSERT OR REPLACE INTO memory_store (namespace, key, value, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run("integrations", "gmail", JSON.stringify({
      client_id: "id.apps.googleusercontent.com",
      client_secret: "GOCSPX-secret",
      refresh_token: "1//refresh",
    }), t, t);
    db.prepare(
      "INSERT OR REPLACE INTO memory_store (namespace, key, value, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run("integrations", "atlassian", JSON.stringify({
      url: "https://team.atlassian.net",
      email: "me@team",
      api_token: "ATATT-tok",
    }), t, t);

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    const integrationCreds = listCredentials({ type: "integration" });
    const gmail = integrationCreds.find((c) => c.id === "integration-gmail")!;
    const atlassian = integrationCreds.find((c) => c.id === "integration-atlassian")!;
    expect(gmail).toBeTruthy();
    expect(atlassian).toBeTruthy();
    expect(gmail.auth_method).toBe("oauth");
    expect(atlassian.auth_method).toBe("api_key");
    expect(getCredentialParams(gmail).refresh_token).toBe("1//refresh");
    expect(getCredentialParams(atlassian).api_token).toBe("ATATT-tok");

    // Legacy memory_store row is left in place — readers don't switch
    // until commit B. Source-of-truth-flip happens there.
    const stillLegacy = db.prepare(
      "SELECT value FROM memory_store WHERE namespace='integrations' AND key='gmail'",
    ).get() as { value: string } | undefined;
    expect(stillLegacy).toBeTruthy();

    // Idempotent: re-running doesn't duplicate.
    const before = listCredentials({ type: "integration" }).length;
    runMigrations(db);
    expect(listCredentials({ type: "integration" }).length).toBe(before);
  });
});
