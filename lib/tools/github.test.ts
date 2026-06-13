/**
 * Adapter integration test — verifies that lib/tools/github.ts wires the
 * @circuitwall/github-langchain package to Jarela's runtime correctly:
 *   - resolves env-var creds (env wins over DB)
 *   - falls back to the encrypted integrations store
 *   - returns a structured error when nothing is configured
 *   - registers each capability bucket with Jarela's tool registry
 *
 * Tool behaviour (HTTP requests, schema validation, helpers) is exercised
 * by the package's own vitest suite under packages/github-langchain/test/.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setupIsolatedToolTest } from "./test-helpers";

const t = setupIsolatedToolTest("jarela-test-github-adapter-", {});

const adapter = await import("./github");
const registry = await import("./registry");
const integrations = await import("@/lib/stores/integrations");

beforeEach(() => {
  t.reset();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  integrations.deleteIntegration("github");
});

describe("github adapter — auth resolution", () => {
  it("returns an error when neither env nor DB is configured", () => {
    const r = adapter._resolveGithubAuth();
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/not configured/i);
  });

  it("resolves from GITHUB_TOKEN env var", () => {
    process.env.GITHUB_TOKEN = "ghp_env";
    expect(adapter._resolveGithubAuth()).toEqual({ token: "ghp_env" });
  });

  it("resolves from GH_TOKEN as the fallback env var", () => {
    process.env.GH_TOKEN = "ghp_fallback";
    expect(adapter._resolveGithubAuth()).toEqual({ token: "ghp_fallback" });
  });

  it("resolves from the encrypted integrations store when env is unset", () => {
    integrations.saveIntegration("github", { token: "ghp_db" });
    expect(adapter._resolveGithubAuth()).toEqual({ token: "ghp_db" });
  });

  it("env wins over the integrations store", () => {
    integrations.saveIntegration("github", { token: "ghp_db" });
    process.env.GITHUB_TOKEN = "ghp_env";
    expect(adapter._resolveGithubAuth()).toEqual({ token: "ghp_env" });
  });
});

describe("github adapter — registry wiring", () => {
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

  it("registers read tools under category=GitHub capability=read", () => {
    const names = entriesFor("GitHub", "read");
    expect(names).toContain("github_get_repo");
    expect(names).toContain("github_search_issues");
    expect(names).toContain("github_get_file");
  });

  it("registers write tools under category=GitHub capability=write", () => {
    const names = entriesFor("GitHub", "write");
    expect(names).toContain("github_create_issue");
    expect(names).toContain("github_create_pull");
    expect(names).toContain("github_create_review");
  });

  it("registers github_merge_pull as execute (not write)", () => {
    expect(registry.registeredCategory("github_merge_pull")).toBe("GitHub");
    expect(registry.registeredCapability("github_merge_pull")).toBe("execute");
  });
});
