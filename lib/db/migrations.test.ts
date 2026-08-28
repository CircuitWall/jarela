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

describe("backfillMailSendTools", () => {
  it("adds send tools to existing agents that already have draft tools", async () => {
    const db = getDb();
    const t = new Date().toISOString();
    const tools = [
      "gmail_search",
      "gmail_create_draft",
      "outlook_search",
      "outlook_create_draft",
    ];
    db.prepare(
      "INSERT OR REPLACE INTO agent_configs (id, name, identity, instructions, tools, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      "legacy-mail-agent",
      "Legacy Mail Agent",
      "mail helper",
      "Drafts are created Ã¢â‚¬â€ never sent automatically.",
      JSON.stringify(tools),
      t,
      t,
    );

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    const row = db.prepare("SELECT instructions, tools FROM agent_configs WHERE id='legacy-mail-agent'").get() as { instructions: string; tools: string };
    const nextTools = JSON.parse(row.tools) as string[];
    expect(nextTools).toContain("gmail_send_email");
    expect(nextTools).toContain("outlook_send_email");
    expect(row.instructions).toContain("send directly only when the user explicitly asks");

    runMigrations(db);
    const after = db.prepare("SELECT tools FROM agent_configs WHERE id='legacy-mail-agent'").get() as { tools: string };
    const afterTools = JSON.parse(after.tools) as string[];
    expect(afterTools.filter((tool) => tool === "gmail_send_email")).toHaveLength(1);
    expect(afterTools.filter((tool) => tool === "outlook_send_email")).toHaveLength(1);
  });
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

  // Property-style sweep: for every shape the legacy panel could have
  // persisted, the migration MUST preserve every field byte-for-byte.
  // This is the regression guard against silent field loss for users
  // upgrading from a pre-credentials build.
  it("preserves every field for every known integration shape", async () => {
    const db = getDb();
    const t = new Date().toISOString();

    const fixtures: Array<{ name: string; value: Record<string, string>; auth_method: "api_key" | "oauth" }> = [
      { name: "anthropic", value: { api_key: "sk-ant-FULL" }, auth_method: "api_key" },
      { name: "google", value: { api_key: "AIza-FULL" }, auth_method: "api_key" },
      { name: "github", value: { token: "ghp_FULL" }, auth_method: "api_key" },
      { name: "atlassian", value: { url: "https://team.atlassian.net", email: "user@team.io", api_token: "ATATT-FULL" }, auth_method: "api_key" },
      { name: "jira_align", value: { url: "https://acme.jiraalign.com", api_token: "eyJ-FULL" }, auth_method: "api_key" },
      { name: "gmail", value: { client_id: "x.apps.googleusercontent.com", client_secret: "GOCSPX-FULL", refresh_token: "1//FULL" }, auth_method: "oauth" },
      { name: "outlook", value: { client_id: "00000000-0000-0000-0000-000000000001", client_secret: "abc~FULL", refresh_token: "0.AXoA-FULL" }, auth_method: "oauth" },
    ];

    // Wipe any state left by earlier tests in this file so we start
    // from a known baseline before seeding the legacy memory rows.
    db.exec("DELETE FROM credentials WHERE type='integration'");
    db.exec("DELETE FROM memory_store WHERE namespace='integrations'");

    for (const f of fixtures) {
      db.prepare(
        "INSERT INTO memory_store (namespace, key, value, created_at, updated_at) VALUES ('integrations', ?, ?, ?, ?)",
      ).run(f.name, JSON.stringify(f.value), t, t);
    }

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    for (const f of fixtures) {
      const cred = listCredentials({ type: "integration", provider: f.name })[0];
      expect(cred, `missing credential for ${f.name}`).toBeTruthy();
      expect(cred.auth_method).toBe(f.auth_method);
      expect(getCredentialParams(cred)).toEqual(f.value);
    }
  });

  it("encrypts the migrated payload at rest (legacy plaintext does not appear in the credentials row)", async () => {
    const db = getDb();
    const SECRET = "sk-ant-encryption-canary-XYZ"; // jarela-secret-ok

    db.exec("DELETE FROM credentials WHERE id='integration-anthropic'");
    db.exec("DELETE FROM memory_store WHERE namespace='integrations' AND key='anthropic'");
    db.prepare(
      "INSERT INTO memory_store (namespace, key, value, created_at, updated_at) VALUES ('integrations', 'anthropic', ?, ?, ?)",
    ).run(JSON.stringify({ api_key: SECRET }), new Date().toISOString(), new Date().toISOString());

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    const row = db.prepare("SELECT params FROM credentials WHERE id='integration-anthropic'").get() as { params: string };
    expect(row).toBeTruthy();
    // The raw column must NOT contain the plaintext secret — envelope
    // encryption is what guarantees on-disk confidentiality once the
    // legacy memory_store row gets swept.
    expect(row.params.includes(SECRET)).toBe(false);
    // But the decrypted read still returns the original value.
    const cred = listCredentials({ type: "integration", provider: "anthropic" })[0];
    expect(getCredentialParams(cred).api_key).toBe(SECRET);
  });

  it("does not overwrite a credential that already exists for the same integration name", async () => {
    const db = getDb();
    const t = new Date().toISOString();

    db.exec("DELETE FROM credentials WHERE id='integration-github'");
    db.exec("DELETE FROM memory_store WHERE namespace='integrations' AND key='github'");

    // Pretend the user already saved a new credential through the new UI.
    const { createCredential } = await import("@/lib/stores/credentials");
    createCredential({
      id: "integration-github",
      type: "integration",
      provider: "github",
      auth_method: "api_key",
      params: { token: "ghp_NEW_FROM_UI" },
    });

    // …and an older legacy row also lingers (e.g. user upgraded mid-edit).
    db.prepare(
      "INSERT INTO memory_store (namespace, key, value, created_at, updated_at) VALUES ('integrations', 'github', ?, ?, ?)",
    ).run(JSON.stringify({ token: "ghp_OLD_LEGACY" }), t, t);

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    // Migration must NOT clobber the existing credential with the
    // stale legacy value. The new UI write wins.
    const cred = listCredentials({ type: "integration", provider: "github" })[0];
    expect(getCredentialParams(cred).token).toBe("ghp_NEW_FROM_UI");
  });

  it("only migrates rows in the `integrations` namespace (leaves other memory_store rows alone)", async () => {
    const db = getDb();
    const t = new Date().toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO memory_store (namespace, key, value, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run("user_prefs", "theme", JSON.stringify({ mode: "dark" }), t, t);

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    // No `credentials` row for a non-integrations memory namespace.
    const stray = db.prepare("SELECT id FROM credentials WHERE id LIKE 'integration-theme%'").all();
    expect(stray.length).toBe(0);
    // And the user_prefs row is still where it was.
    const pref = db.prepare("SELECT value FROM memory_store WHERE namespace='user_prefs' AND key='theme'").get() as { value: string };
    expect(pref.value).toContain("dark");
  });

  // Production regression guard: memory_store rows in sensitive
  // namespaces (including `integrations`) are envelope-encrypted at
  // rest via the on-boot encryption sweep (ADR-0005). An earlier draft
  // of this migration tried to JSON.parse the raw value, silently
  // failed via `catch { continue }`, and skipped EVERY integration on
  // real user databases. This test seeds the row in the same encrypted
  // form production stores it to lock in the fix.
  it("handles envelope-encrypted memory_store values (production shape)", async () => {
    const db = getDb();
    const t = new Date().toISOString();

    db.exec("DELETE FROM credentials WHERE id='integration-google'");
    db.exec("DELETE FROM memory_store WHERE namespace='integrations' AND key='google'");

    const SECRET = "AIza-PRODUCTION-SHAPE";
    const ciphertext = encrypt(JSON.stringify({ api_key: SECRET }));
    expect(ciphertext.includes(SECRET)).toBe(false); // sanity: actually encrypted

    db.prepare(
      "INSERT INTO memory_store (namespace, key, value, created_at, updated_at) VALUES ('integrations', 'google', ?, ?, ?)",
    ).run(ciphertext, t, t);

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    const cred = listCredentials({ type: "integration", provider: "google" })[0];
    expect(cred, "google credential should exist after migration").toBeTruthy();
    expect(getCredentialParams(cred).api_key).toBe(SECRET);
  });
});

describe("backfillDeveloperInteractiveTerminalTools", () => {
  it("updates the developer seed to prefer interactive terminal tools", async () => {
    const db = getDb();

    db.prepare(
      "UPDATE agent_configs SET instructions=?, tools=?, updated_at=? WHERE id='developer'",
    ).run(
      "Read before you write. Use file_list / file_read / file_stat to map the code, then file_edit for surgical changes and file_write only for new files. After every meaningful edit, run the project's build, lint, or test command via shell_exec (or local_exec for a single binary) and read the output before declaring success â€” never claim a fix without proof. Use github_* to look up issues/PRs for context. Prefer the smallest change that solves the problem; never invent paths or APIs.",
      JSON.stringify(["file_read", "file_write", "file_edit", "file_list", "file_stat", "file_mkdir", "file_move", "file_copy", "file_delete", "local_exec", "shell_exec", "web_fetch", "web_search", "github_search_issues", "github_get_issue", "github_list_pulls", "github_get_pull", "github_get_repo", "memory_read", "memory_write", "memory_list"]),
      new Date().toISOString(),
    );

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    const row = db.prepare("SELECT instructions, tools FROM agent_configs WHERE id='developer'").get() as { instructions: string; tools: string };
    const tools = JSON.parse(row.tools) as string[];

    expect(tools).toEqual(expect.arrayContaining([
      "terminal_open",
      "terminal_exec",
      "terminal_send",
      "terminal_read",
      "terminal_close",
      "terminal_list",
    ]));
    expect(row.instructions).toContain("terminal_open + terminal_exec + terminal_read");
    expect(row.instructions).not.toContain("shell_exec (or local_exec for a single binary)");
  });
});

describe("ensureCredentialsLabelAndDefaultColumns", () => {
  // Regression: the NULL-label backfill MUST run only once (when the
  // `label` column is first added), not on every boot. Otherwise
  // second-of-pair credentials — which the store layer intentionally
  // creates with label=NULL — would be silently relabelled "Default"
  // on the next server restart, polluting the panel.
  it("does not relabel second-of-pair rows on a subsequent migration pass", async () => {
    const db = getDb();
    const { createCredential, getCredential } = await import("@/lib/stores/credentials");

    // First-of-pair gets label="Default" automatically.
    const a = createCredential({
      type: "model",
      provider: "label-stability-test",
      params: { api_key: "k1" },
    });
    expect(a.label).toBe("Default");

    // Second-of-pair MUST stay NULL — that's the contract that the
    // panel reads to decide whether to render the id as a fallback.
    const b = createCredential({
      type: "model",
      provider: "label-stability-test",
      params: { api_key: "k2" },
    });
    expect(b.label).toBeNull();

    // Boot the migration pass again. The label column already exists,
    // so the one-shot backfill must NOT fire — `b` keeps its NULL label.
    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    expect(getCredential(a.id)?.label).toBe("Default");
    expect(getCredential(b.id)?.label).toBeNull();
  });
});

describe("router column migration", () => {
  it("adds router columns on an existing database even when there are no legacy image rows", async () => {
    const db = getDb();

    db.exec("ALTER TABLE agent_configs DROP COLUMN router_policy");
    db.exec("ALTER TABLE agent_configs DROP COLUMN router_enabled");
    db.exec("DELETE FROM messages");

    const before = db.prepare("PRAGMA table_info(agent_configs)").all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === "router_policy")).toBe(false);
    expect(before.some((c) => c.name === "router_enabled")).toBe(false);

    const { runMigrations } = await import("@/lib/db/migrations");
    runMigrations(db);

    const after = db.prepare("PRAGMA table_info(agent_configs)").all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === "router_policy")).toBe(true);
    expect(after.some((c) => c.name === "router_enabled")).toBe(true);
  });
});

