import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-providers-info-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { listProvidersTool, describeProviderTool } = await import("./providers-info");

function parse<T = unknown>(s: string): T {
  return JSON.parse(s) as T;
}

describe("list_providers", () => {
  it("returns all built-in providers with source label", async () => {
    const out = parse<{
      providers: Array<{ name: string; source: string }>;
      count: number;
      builtin_count: number;
      external_count: number;
    }>(await listProvidersTool.invoke({}));

    const names = out.providers.map((p) => p.name);
    expect(names).toContain("anthropic");
    expect(names).toContain("openai");
    expect(names).toContain("gemini");
    expect(out.providers.every((p) => p.source === "builtin" || p.source === "external")).toBe(true);
    expect(out.count).toBe(out.providers.length);
    expect(out.builtin_count + out.external_count).toBe(out.count);
  });
});

describe("describe_provider", () => {
  it("returns capability flags and known models for anthropic", async () => {
    const out = parse<{
      name: string;
      source: string;
      capabilities: Record<string, boolean>;
      known_models: Array<{ model_id: string; context_length: number }>;
    }>(await describeProviderTool.invoke({ name: "anthropic" }));

    expect(out.name).toBe("anthropic");
    expect(out.source).toBe("builtin");
    expect(out.capabilities.chat).toBe(true);
    expect(out.capabilities.invoke).toBe(true);
    expect(out.capabilities.stream_invoke).toBe(true);
    // Anthropic adapter does not implement embed today.
    expect(out.capabilities.embed).toBe(false);
    expect(out.known_models.length).toBeGreaterThan(0);
    expect(out.known_models.some((m) => m.model_id.startsWith("claude-"))).toBe(true);
  });

  it("returns an error object (not throw) for unknown provider", async () => {
    const out = parse<{ error?: string; hint?: string }>(
      await describeProviderTool.invoke({ name: "nonexistent-provider-xyz" }),
    );
    expect(out.error).toBeDefined();
    expect(out.hint).toMatch(/list_providers/);
  });

  it("returns an empty known_models list for providers without static catalog", async () => {
    const out = parse<{ known_models: unknown[] }>(
      await describeProviderTool.invoke({ name: "langchain" }),
    );
    expect(out.known_models).toEqual([]);
  });
});
