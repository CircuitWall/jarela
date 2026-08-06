import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set JARELA_DB_DIR before any import so PROVIDERS_DIR resolves to our tmp dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-ext-providers-"));
process.env.JARELA_DB_DIR = tmpRoot;

const providersDir = join(tmpRoot, "providers");
mkdirSync(providersDir, { recursive: true });

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function writeProvider(name: string, content: string): void {
  writeFileSync(join(providersDir, `${name}.cjs`), content);
}

const { loadExternalProvidersDetailed } = await import("./external");

const BUILTINS: ReadonlySet<string> = new Set(["anthropic", "openai"]);

describe("loadExternalProvidersDetailed — credential field parsing", () => {
  it("loads a provider with no credentials field", () => {
    writeProvider("no-creds", `
      module.exports = {
        name: "no-creds",
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    const result = loadExternalProvidersDetailed(BUILTINS);
    expect(result.providers["no-creds"]).toBeDefined();
    expect(result.credentials.get("no-creds")).toEqual([]);
  });

  it("parses credentials, label, and description from the module export", () => {
    writeProvider("my-llm", `
      module.exports = {
        name: "my-llm",
        label: "My LLM",
        description: "Custom LLM provider.",
        credentials: [
          { key: "api_key", label: "API Key", placeholder: "sk-...", secret: true, required: true },
          { key: "base_url", label: "Base URL", secret: false, required: false },
        ],
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    const result = loadExternalProvidersDetailed(BUILTINS);
    expect(result.providers["my-llm"]).toBeDefined();
    expect(result.labels.get("my-llm")).toBe("My LLM");
    expect(result.descriptions.get("my-llm")).toBe("Custom LLM provider.");
    const creds = result.credentials.get("my-llm")!;
    expect(creds).toHaveLength(2);
    expect(creds[0]).toMatchObject({ key: "api_key", secret: true, required: true });
    expect(creds[1]).toMatchObject({ key: "base_url", secret: false, required: false });
  });

  it("rejects a provider whose credentials field contains an invalid slot", () => {
    writeProvider("bad-creds", `
      module.exports = {
        name: "bad-creds",
        credentials: [
          { key: "not valid key!", label: "x", secret: true, required: true },
        ],
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    const result = loadExternalProvidersDetailed(BUILTINS);
    // Invalid credentials → whole provider is rejected as invalid
    expect(result.providers["bad-creds"]).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a provider whose credentials field is not an array", () => {
    writeProvider("bad-creds-type", `
      module.exports = {
        name: "bad-creds-type",
        credentials: "should-be-an-array",
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    const result = loadExternalProvidersDetailed(BUILTINS);
    expect(result.providers["bad-creds-type"]).toBeUndefined();
  });

  it("does not populate labels/descriptions maps when not declared", () => {
    writeProvider("minimal", `
      module.exports = {
        name: "minimal",
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    const result = loadExternalProvidersDetailed(BUILTINS);
    expect(result.labels.has("minimal")).toBe(false);
    expect(result.descriptions.has("minimal")).toBe(false);
  });

  it("skips a provider whose name collides with a built-in", () => {
    writeProvider("anthropic", `
      module.exports = {
        name: "anthropic",
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    const result = loadExternalProvidersDetailed(BUILTINS);
    // anthropic is in BUILTINS so it should be skipped (not in providers OR errors list
    // — the scanner silently discards name collisions with builtins)
    expect(result.providers["anthropic"]).toBeUndefined();
  });
});
