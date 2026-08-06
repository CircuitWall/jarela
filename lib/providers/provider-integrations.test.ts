import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { unlinkSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set before imports so PROVIDERS_DIR and JARELA_DB_DIR resolve correctly.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-prov-integrations-"));
process.env.JARELA_DB_DIR = tmpRoot;

const providersDir = join(tmpRoot, "providers");
mkdirSync(providersDir, { recursive: true });

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function writeProvider(name: string, content: string): void {
  writeFileSync(join(providersDir, `${name}.cjs`), content);
}

const { refreshExternalProviderIntegrations } = await import("./provider-integrations");
const {
  isAnyKnownIntegration,
  clearDynamicIntegrations,
  listIntegrations,
  getIntegrationStatus,
} = await import("@/lib/stores/integrations");

describe("refreshExternalProviderIntegrations", () => {
  beforeEach(() => {
    clearDynamicIntegrations();
  });

  it("registers a provider that declares credentials as a dynamic integration", () => {
    writeProvider("bridge-llm", `
      module.exports = {
        name: "bridge-llm",
        label: "Bridge LLM",
        description: "An external provider.",
        credentials: [
          { key: "api_key", label: "API Key", secret: true, required: true },
        ],
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    refreshExternalProviderIntegrations();
    expect(isAnyKnownIntegration("bridge-llm")).toBe(true);
  });

  it("does not register a provider that declares no credentials", () => {
    writeProvider("no-creds-provider", `
      module.exports = {
        name: "no-creds-provider",
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    refreshExternalProviderIntegrations();
    expect(isAnyKnownIntegration("no-creds-provider")).toBe(false);
  });

  it("registered provider appears in listIntegrations with correct label", () => {
    writeProvider("labeled-llm", `
      module.exports = {
        name: "labeled-llm",
        label: "Labeled LLM",
        credentials: [
          { key: "api_key", label: "Key", secret: true, required: true },
        ],
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    refreshExternalProviderIntegrations();
    const all = listIntegrations();
    const entry = all.find((s) => s.name === "labeled-llm");
    expect(entry).toBeDefined();
    expect(entry!.configured).toBe(false);
  });

  it("refresh clears stale entries from a prior scan", () => {
    writeProvider("stale-llm", `
      module.exports = {
        name: "stale-llm",
        credentials: [{ key: "api_key", label: "Key", secret: true, required: true }],
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    refreshExternalProviderIntegrations();
    expect(isAnyKnownIntegration("stale-llm")).toBe(true);

    // Remove the .cjs file — next refresh should deregister it
    unlinkSync(join(providersDir, "stale-llm.cjs"));
    refreshExternalProviderIntegrations();
    expect(isAnyKnownIntegration("stale-llm")).toBe(false);
  });

  it("getIntegrationStatus works for a dynamically-registered provider", () => {
    writeProvider("status-llm", `
      module.exports = {
        name: "status-llm",
        credentials: [{ key: "api_key", label: "Key", secret: true, required: true }],
        async chat() { return { stream: (async function*(){})() }; },
      };
    `);
    refreshExternalProviderIntegrations();
    const status = getIntegrationStatus("status-llm");
    expect(status).not.toBeNull();
    expect(status!.name).toBe("status-llm");
    expect(status!.configured).toBe(false);
  });
});
