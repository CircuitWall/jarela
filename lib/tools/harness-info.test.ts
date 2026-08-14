import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-harness-info-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { listHarnessesTool, readHarnessTool } = await import("./harness-info");

function parse(s: unknown) {
  return JSON.parse(String(s)) as Record<string, unknown>;
}

describe("harness introspection tools", () => {
  it("lists the default built-in harness", async () => {
    const out = parse(await listHarnessesTool.invoke({}));
    const harnesses = out.harnesses as Array<Record<string, unknown>>;
    expect(out.default_harness_id).toBe("builtin:default");
    expect(harnesses.some((h) => h.id === "builtin:default" && h.builtin === true)).toBe(true);
  });

  it("reads harness section bodies", async () => {
    const out = parse(await readHarnessTool.invoke({ id: "builtin:default" }));
    const harness = out.harness as { sections: Record<string, { enabled: boolean; body: string }> };
    expect(harness.sections.capabilities.enabled).toBe(true);
    expect(harness.sections.capabilities.body).toContain("Host UI capabilities");
  });
});
