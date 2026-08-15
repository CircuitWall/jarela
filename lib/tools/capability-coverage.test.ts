import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-capability-coverage-"));
process.env.JARELA_DB_DIR = tmpRoot;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

await import("./builtins");
const { registeredTools, registeredCapability } = await import("./registry");

// Ensures every built-in tool was registered with a capability. The
// registerTools signature already enforces this at compile time
// (Capability is a required arg, not optional), but this runtime check
// catches accidental skips and serves as living documentation: when a new
// tool lands, the test prints which file is missing it. See ADR-0038.

describe("capability coverage", () => {
  it("every registered built-in tool has a capability", () => {
    const tools = registeredTools();
    expect(tools.length).toBeGreaterThan(0);

    const missing = tools
      .map((t) => ({ name: t.name, cap: registeredCapability(t.name) }))
      .filter((x) => !x.cap)
      .map((x) => x.name);

    expect(missing, `tools missing capability: ${missing.join(", ")}`).toEqual([]);
  });

  it("capability values are limited to the closed enum", () => {
    const allowed = new Set(["read", "write", "execute"]);
    for (const t of registeredTools()) {
      const cap = registeredCapability(t.name);
      expect(allowed.has(cap as string), `${t.name} has invalid capability: ${cap}`).toBe(true);
    }
  });

  it("read/write/execute distribution sanity (every bucket non-empty)", () => {
    const counts = { read: 0, write: 0, execute: 0 };
    for (const t of registeredTools()) {
      const cap = registeredCapability(t.name);
      if (cap) counts[cap]++;
    }
    expect(counts.read, "no read-capability tools registered").toBeGreaterThan(0);
    expect(counts.write, "no write-capability tools registered").toBeGreaterThan(0);
    expect(counts.execute, "no execute-capability tools registered").toBeGreaterThan(0);
  });
});
