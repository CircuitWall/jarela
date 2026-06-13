/**
 * Adapter integration test — verifies that lib/tools/jira-align.ts wires
 * the @circuitwall/jira-align-langchain package to Jarela's runtime
 * correctly:
 *   - resolves env-var creds (env wins over DB)
 *   - falls back to the encrypted integrations store
 *   - returns a structured error when nothing is configured
 *   - registers each capability bucket with Jarela's tool registry
 *
 * Tool behaviour (HTTP requests, OData filters, response shaping) is
 * exercised by the package's own vitest suite under
 * packages/jira-align-langchain/test/.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setupIsolatedToolTest } from "./test-helpers";

const t = setupIsolatedToolTest("jarela-test-jira-align-adapter-", {});

const adapter = await import("./jira-align");
const registry = await import("./registry");
const integrations = await import("@/lib/stores/integrations");

beforeEach(() => {
  t.reset();
  delete process.env.JIRA_ALIGN_URL;
  delete process.env.JIRA_ALIGN_TOKEN;
  integrations.deleteIntegration("jira_align");
});

describe("jira-align adapter — auth resolution", () => {
  it("returns an error when neither env nor DB is configured", () => {
    const r = adapter._resolveJiraAlignAuth();
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/not configured/i);
  });

  it("resolves from JIRA_ALIGN_URL + JIRA_ALIGN_TOKEN env vars", () => {
    process.env.JIRA_ALIGN_URL = "https://env.jiraalign.com";
    process.env.JIRA_ALIGN_TOKEN = "env-token";
    expect(adapter._resolveJiraAlignAuth()).toEqual({
      url: "https://env.jiraalign.com",
      apiToken: "env-token",
    });
  });

  it("strips trailing slashes from env JIRA_ALIGN_URL", () => {
    process.env.JIRA_ALIGN_URL = "https://env.jiraalign.com/";
    process.env.JIRA_ALIGN_TOKEN = "env-token";
    const r = adapter._resolveJiraAlignAuth();
    expect("url" in r && r.url).toBe("https://env.jiraalign.com");
  });

  it("resolves from the encrypted integrations store when env is unset", () => {
    integrations.saveIntegration("jira_align", {
      url: "https://db.jiraalign.com",
      api_token: "db-token",
    });
    expect(adapter._resolveJiraAlignAuth()).toEqual({
      url: "https://db.jiraalign.com",
      apiToken: "db-token",
    });
  });

  it("env wins over the integrations store", () => {
    integrations.saveIntegration("jira_align", {
      url: "https://db.jiraalign.com",
      api_token: "db-token",
    });
    process.env.JIRA_ALIGN_URL = "https://env.jiraalign.com";
    process.env.JIRA_ALIGN_TOKEN = "env-token";
    expect(adapter._resolveJiraAlignAuth()).toEqual({
      url: "https://env.jiraalign.com",
      apiToken: "env-token",
    });
  });
});

describe("jira-align adapter — registry wiring", () => {
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

  it("registers read tools under category=JiraAlign capability=read", () => {
    const names = entriesFor("JiraAlign", "read");
    expect(names).toContain("jira_align_get_item");
    expect(names).toContain("jira_align_search_items");
    expect(names).toContain("jira_align_list_entities");
  });

  it("registers write tools under category=JiraAlign capability=write", () => {
    const names = entriesFor("JiraAlign", "write");
    expect(names).toContain("jira_align_create_item");
    expect(names).toContain("jira_align_create_entity");
    expect(names).toContain("jira_align_create_dependency");
  });

  it("registers jira_align_transition_item as execute (not write)", () => {
    expect(registry.registeredCategory("jira_align_transition_item")).toBe("JiraAlign");
    expect(registry.registeredCapability("jira_align_transition_item")).toBe("execute");
  });
});
