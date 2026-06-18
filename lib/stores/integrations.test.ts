import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-integrations-store-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Boot the db once so the credentials table + migration helpers are wired
// before any of the store helpers are touched.
const { getDb } = await import("@/lib/db");
const {
  saveIntegration,
  getIntegrationStatus,
  getIntegrationRaw,
  getIntegrationRawById,
  listIntegrations,
  deleteIntegration,
  SECRET_MASK,
} = await import("./integrations");
const { createCredential, listCredentials, setDefaultCredential } = await import("./credentials");
const { runWithToolCredentialContext } = await import("@/lib/tools/credential-context");

function wipeAll(): void {
  const db = getDb();
  db.exec("DELETE FROM credentials WHERE type='integration'");
  db.exec("DELETE FROM memory_store WHERE namespace='integrations'");
}

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe("integrations store (credentials-backed)", () => {
  beforeEach(() => wipeAll());

  // Tabular round-trip — saves the canonical shape for each known
  // integration and asserts getIntegrationRaw returns it byte-for-byte.
  // If the credentials backing ever drops or coerces a field, this
  // breaks on the first user to upgrade. Single most important guard.
  const fixtures: Array<{ name: string; value: Record<string, string> }> = [
    { name: "anthropic", value: { api_key: "sk-ant-roundtrip" } },
    { name: "google", value: { api_key: "AIza-roundtrip" } },
    { name: "github", value: { token: "ghp_roundtrip" } },
    { name: "atlassian", value: { url: "https://r.atlassian.net", email: "r@r.io", api_token: "ATATT-roundtrip" } },
    { name: "jira_align", value: { url: "https://r.jiraalign.com", api_token: "eyJ-roundtrip" } },
    { name: "gmail", value: { client_id: "r.apps.googleusercontent.com", client_secret: "GOCSPX-roundtrip", refresh_token: "1//roundtrip" } },
    { name: "outlook", value: { client_id: "00000000-0000-0000-0000-000000000099", client_secret: "abc~roundtrip", refresh_token: "0.AXoA-roundtrip" } },
  ];

  for (const f of fixtures) {
    it(`save → getIntegrationRaw preserves every field for ${f.name}`, () => {
      const r = saveIntegration(f.name, f.value);
      expect("error" in r ? r.error : null).toBeNull();
      const raw = getIntegrationRaw(f.name);
      expect(raw).toEqual(f.value);
    });
  }

  it("returns SECRET_MASK on getIntegrationStatus for secret fields", () => {
    saveIntegration("atlassian", { url: "https://a.atlassian.net", email: "a@a", api_token: "ATATT-secret" });
    const status = getIntegrationStatus("atlassian")!;
    expect(status.values.email).toBe("a@a");
    expect(status.values.url).toBe("https://a.atlassian.net");
    expect(status.values.api_token).toBe(SECRET_MASK);
  });

  it("preserves existing secret when the UI re-saves with SECRET_MASK", () => {
    saveIntegration("anthropic", { api_key: "sk-ant-ORIGINAL" });
    // Simulate the UI round-trip: client received SECRET_MASK, didn't
    // edit it, sent it back. The server must keep ORIGINAL, not blank it.
    saveIntegration("anthropic", { api_key: SECRET_MASK });
    expect(getIntegrationRaw("anthropic")?.api_key).toBe("sk-ant-ORIGINAL");
  });

  it("updates fields in place — no duplicate credential rows on re-save", () => {
    saveIntegration("github", { token: "ghp_v1" });
    saveIntegration("github", { token: "ghp_v2" });
    const rows = listCredentials({ type: "integration", provider: "github" });
    expect(rows.length).toBe(1);
    expect(getIntegrationRaw("github")?.token).toBe("ghp_v2");
  });

  it("listIntegrations enumerates every known integration with correct configured flag", () => {
    saveIntegration("anthropic", { api_key: "sk-ant-listed" });
    const all = listIntegrations();
    // Spot a few well-known names.
    expect(all.find((s) => s.name === "anthropic")?.configured).toBe(true);
    expect(all.find((s) => s.name === "atlassian")?.configured).toBe(false);
    expect(all.find((s) => s.name === "gmail")?.configured).toBe(false);
  });

  it("deleteIntegration removes the credential and only the targeted provider", () => {
    saveIntegration("anthropic", { api_key: "sk-keep" });
    saveIntegration("github", { token: "ghp-drop" });
    expect(deleteIntegration("github")).toBe(true);
    expect(getIntegrationRaw("github")).toBeNull();
    // Untouched providers stay.
    expect(getIntegrationRaw("anthropic")?.api_key).toBe("sk-keep");
  });

  it("deleteIntegration purges every credential row for that provider (multi-instance future)", () => {
    // Pre-stage two credentials for the same integration name as a user
    // would if the panel grew multi-instance support.
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_one" } });
    createCredential({ id: "integration-github-2", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_two" } });
    expect(listCredentials({ type: "integration", provider: "github" }).length).toBe(2);

    expect(deleteIntegration("github")).toBe(true);
    expect(listCredentials({ type: "integration", provider: "github" }).length).toBe(0);
  });

  it("does not touch credentials of other types", () => {
    createCredential({ type: "model", provider: "anthropic", params: { api_key: "sk-model-isolated" } });
    saveIntegration("anthropic", { api_key: "sk-int-anth" });
    deleteIntegration("anthropic");
    const modelCreds = listCredentials({ type: "model", provider: "anthropic" });
    expect(modelCreds.some((c) => c.id === "model-anthropic")).toBe(true);
  });

  it("first save after a legacy migration sweeps the plaintext memory_store row", () => {
    const db = getDb();
    // Simulate the state right after commit A: credential exists AND the
    // legacy plaintext row is still lingering (the migration leaves it
    // intentionally for back-compat during the same release). The very
    // next save must purge it so secrets aren't left in plaintext.
    const t = new Date().toISOString();
    db.prepare(
      "INSERT INTO memory_store (namespace, key, value, created_at, updated_at) VALUES ('integrations', 'github', ?, ?, ?)",
    ).run(JSON.stringify({ token: "ghp_legacy_plaintext" }), t, t);

    saveIntegration("github", { token: "ghp_new" });

    const stillThere = db.prepare(
      "SELECT 1 FROM memory_store WHERE namespace='integrations' AND key='github'",
    ).get();
    expect(stillThere).toBeUndefined();
    expect(getIntegrationRaw("github")?.token).toBe("ghp_new");
  });

  it("rejects unknown integration names from save and delete", () => {
    const r = saveIntegration("not-a-real-integration", { api_key: "x" });
    expect("error" in r).toBe(true);
    expect(deleteIntegration("also-fake")).toBe(false);
  });

  it("rejects an empty required field instead of silently writing it", () => {
    const r = saveIntegration("anthropic", { api_key: "   " });
    expect("error" in r).toBe(true);
    // And no credential was created as a side effect of the failed write.
    expect(listCredentials({ type: "integration", provider: "anthropic" }).length).toBe(0);
  });
});

describe("integrations store: multi-instance + ALS routing", () => {
  beforeEach(() => wipeAll());

  it("getIntegrationRaw resolves the default credential when no ALS frame is active", () => {
    // Two credentials for the same integration; promote the second as default.
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_default_was_first" } });
    const second = createCredential({ id: "integration-github-work", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_now_default" } });
    setDefaultCredential(second.id);
    expect(getIntegrationRaw("github")?.token).toBe("ghp_now_default");
  });

  it("getIntegrationRawById loads a specific credential regardless of default flag", () => {
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_default" } });
    createCredential({ id: "integration-github-personal", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_personal" } });
    expect(getIntegrationRawById("integration-github-personal")?.token).toBe("ghp_personal");
    expect(getIntegrationRawById("integration-github")?.token).toBe("ghp_default");
  });

  it("getIntegrationRawById returns null for unknown ids", () => {
    expect(getIntegrationRawById("does-not-exist")).toBeNull();
  });

  it("ALS frame with matching provider routes getIntegrationRaw to the override credential", () => {
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_default" } });
    createCredential({ id: "integration-github-work", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_work" } });

    const out = runWithToolCredentialContext(
      { toolName: "github_create_issue", toolCredentials: { github_create_issue: "integration-github-work" } },
      () => getIntegrationRaw("github"),
    );
    expect(out?.token).toBe("ghp_work");
  });

  it("ALS override for a different tool name falls back to the default", () => {
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_default" } });
    createCredential({ id: "integration-github-work", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_work" } });

    const out = runWithToolCredentialContext(
      // Override only applies to a different tool name — current resolver
      // sees no entry for "github_list_repos" and uses the default.
      { toolName: "github_list_repos", toolCredentials: { github_create_issue: "integration-github-work" } },
      () => getIntegrationRaw("github"),
    );
    expect(out?.token).toBe("ghp_default");
  });

  it("ALS override pointing at the WRONG provider is ignored (security)", () => {
    // gmail tool that mistakenly points at a github credential id must
    // NOT leak the github token through getIntegrationRaw("gmail").
    createCredential({ id: "integration-gmail", type: "integration", provider: "gmail", auth_method: "oauth", params: { client_id: "cid", client_secret: "sec", refresh_token: "rt" } });
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_should_not_leak" } });

    const out = runWithToolCredentialContext(
      { toolName: "gmail_send", toolCredentials: { gmail_send: "integration-github" } },
      () => getIntegrationRaw("gmail"),
    );
    // Falls back to the gmail default credential, not the github one.
    expect(out?.client_id).toBe("cid");
    expect(out?.refresh_token).toBe("rt");
    // And definitely no github fields bled into the response.
    expect((out as Record<string, string>).token).toBeUndefined();
  });

  it("ALS override pointing at a stale/deleted id falls through to the default", () => {
    createCredential({ id: "integration-github", type: "integration", provider: "github", auth_method: "api_key", params: { token: "ghp_default" } });

    const out = runWithToolCredentialContext(
      { toolName: "github_create_issue", toolCredentials: { github_create_issue: "integration-github-deleted" } },
      () => getIntegrationRaw("github"),
    );
    expect(out?.token).toBe("ghp_default");
  });
});
