import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-extension-surfaces-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { describeExtensionSurfacesTool } = await import("./extension-surfaces");

interface Surface {
  id: string;
  name: string;
  summary: string;
  registration_entrypoint: string;
  doc_section: string;
  example_path?: string;
  introspection_tool?: string;
  related_adrs: string[];
}

interface Result {
  surfaces: Surface[];
  count: number;
  guide_path: string;
  contract_paths: string[];
  notes: string[];
}

describe("describe_extension_surfaces", () => {
  let out: Result;

  it("returns the curated catalog with all required fields", async () => {
    out = JSON.parse(await describeExtensionSurfacesTool.invoke({})) as Result;
    expect(out.count).toBe(out.surfaces.length);
    expect(out.guide_path).toBe("docs/EXTENDING.md");
    expect(out.contract_paths.length).toBeGreaterThan(0);
    expect(out.notes.length).toBeGreaterThan(0);
  });

  it("includes the core extension points", () => {
    const ids = out.surfaces.map((s) => s.id).sort();
    expect(ids).toContain("llm_provider_builtin");
    expect(ids).toContain("llm_provider_external");
    expect(ids).toContain("builtin_tool");
    expect(ids).toContain("mcp_server");
    expect(ids).toContain("agent_harness");
    expect(ids).toContain("integration_manifest");
    expect(ids).toContain("brand_overlay");
  });

  it("every surface has a registration entrypoint, doc section, and at least one ADR reference", () => {
    for (const s of out.surfaces) {
      expect(s.registration_entrypoint).toBeTruthy();
      expect(s.doc_section.startsWith("docs/EXTENDING.md#")).toBe(true);
      expect(Array.isArray(s.related_adrs)).toBe(true);
      expect(s.related_adrs.length).toBeGreaterThan(0);
    }
  });

  it("introspection_tool references match real tool names", () => {
    const expectedTools = new Set([
      "list_providers",
      "list_tools",
      "list_mcp_servers",
      "list_integrations",
    ]);
    for (const s of out.surfaces) {
      if (s.introspection_tool) {
        expect(expectedTools.has(s.introspection_tool)).toBe(true);
      }
    }
  });
});
