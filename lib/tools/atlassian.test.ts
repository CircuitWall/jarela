/**
 * Adapter integration test — verifies that lib/tools/atlassian.ts wires
 * the @circuitwall/atlassian-langchain package to Jarela's runtime
 * correctly:
 *   - resolves env-var creds (env wins over DB)
 *   - falls back to the encrypted integrations store
 *   - returns a structured error when nothing is configured
 *   - registers each capability bucket with Jarela's tool registry
 *
 * Tool behaviour (HTTP requests, ADF rendering, OData / JQL filters,
 * response shaping) is exercised by the package's own vitest suite under
 * packages/atlassian-langchain/test/.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setupIsolatedToolTest } from "./test-helpers";

const t = setupIsolatedToolTest("jarela-test-atlassian-adapter-", {});

const adapter = await import("./atlassian");
const registry = await import("./registry");
const integrations = await import("@/lib/stores/integrations");

beforeEach(() => {
  t.reset();
  delete process.env.ATLASSIAN_URL;
  delete process.env.ATLASSIAN_EMAIL;
  delete process.env.ATLASSIAN_API_TOKEN;
  integrations.deleteIntegration("atlassian");
});

describe("atlassian adapter — auth resolution", () => {
  it("returns an error when neither env nor DB is configured", () => {
    const r = adapter._resolveAtlassianAuth();
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/not configured/i);
  });

  it("resolves from ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars", () => {
    process.env.ATLASSIAN_URL = "https://env.atlassian.net";
    process.env.ATLASSIAN_EMAIL = "env@example.com";
    process.env.ATLASSIAN_API_TOKEN = "env-token";
    expect(adapter._resolveAtlassianAuth()).toEqual({
      url: "https://env.atlassian.net",
      email: "env@example.com",
      apiToken: "env-token",
    });
  });

  it("resolves from the encrypted integrations store when env is unset", () => {
    integrations.saveIntegration("atlassian", {
      url: "https://db.atlassian.net",
      email: "db@example.com",
      api_token: "db-token",
    });
    expect(adapter._resolveAtlassianAuth()).toEqual({
      url: "https://db.atlassian.net",
      email: "db@example.com",
      apiToken: "db-token",
    });
  });

  it("strips trailing slashes from the saved integration URL", () => {
    integrations.saveIntegration("atlassian", {
      url: "https://db.atlassian.net/",
      email: "db@example.com",
      api_token: "db-token",
    });
    const r = adapter._resolveAtlassianAuth();
    expect("url" in r && r.url).toBe("https://db.atlassian.net");
  });

  it("env wins over the integrations store", () => {
    integrations.saveIntegration("atlassian", {
      url: "https://db.atlassian.net",
      email: "db@example.com",
      api_token: "db-token",
    });
    process.env.ATLASSIAN_URL = "https://env.atlassian.net";
    process.env.ATLASSIAN_EMAIL = "env@example.com";
    process.env.ATLASSIAN_API_TOKEN = "env-token";
    expect(adapter._resolveAtlassianAuth()).toEqual({
      url: "https://env.atlassian.net",
      email: "env@example.com",
      apiToken: "env-token",
    });
  });
});

describe("atlassian adapter — registry wiring", () => {
  function entriesFor(category: string, capability: string): string[] {
    return registry
      .registeredTools()
      .map((t) => t.name)
      .filter(
        (n) =>
          registry.registeredCategory(n) === category &&
          registry.registeredCapability(n) === capability,
      );
  }

  it("registers Jira + Confluence read tools under category=Atlassian capability=read", () => {
    const names = entriesFor("Atlassian", "read");
    expect(names).toContain("jira_search");
    expect(names).toContain("jira_get_issue");
    expect(names).toContain("confluence_search");
    expect(names).toContain("confluence_get_page");
  });

  it("registers write tools under category=Atlassian capability=write", () => {
    const names = entriesFor("Atlassian", "write");
    expect(names).toContain("jira_create_issue");
    expect(names).toContain("jira_update_issue");
    expect(names).toContain("confluence_create_page");
    expect(names).toContain("confluence_update_page");
  });

  it("registers execute tools under category=Atlassian capability=execute", () => {
    const names = entriesFor("Atlassian", "execute");
    expect(names).toContain("jira_transition_issue");
  });
});
