import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test run — point JARELA_DB_DIR at a tmp dir BEFORE
// importing modules that open the DB.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-displayfilters-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  upsertAgentConfig,
  getAgentDisplayFilters,
  updateAgentDisplayFilters,
  DISPLAY_FILTER_DEFAULTS,
} = await import("./agent-configs");

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

const seedAgent = (id: string) =>
  upsertAgentConfig({
    id,
    name: id,
    identity: "",
    instructions: "",
    tools: [],
  });

describe("agent display filters (ADR-0022)", () => {
  beforeEach(() => {
    seedAgent("filter-test");
    updateAgentDisplayFilters("filter-test", null); // reset
  });

  it("returns defaults when nothing has been written", () => {
    expect(getAgentDisplayFilters("filter-test")).toEqual(DISPLAY_FILTER_DEFAULTS);
  });

  it("returns null for an unknown agent", () => {
    expect(getAgentDisplayFilters("does-not-exist")).toBeNull();
  });

  it("merges a partial patch over current state", () => {
    updateAgentDisplayFilters("filter-test", { thinking: false });
    expect(getAgentDisplayFilters("filter-test")).toEqual({
      ...DISPLAY_FILTER_DEFAULTS,
      thinking: false,
    });

    updateAgentDisplayFilters("filter-test", { tool_use: false });
    expect(getAgentDisplayFilters("filter-test")).toEqual({
      ...DISPLAY_FILTER_DEFAULTS,
      thinking: false,
      tool_use: false,
    });
  });

  it("ignores non-boolean / unknown patch fields", () => {
    updateAgentDisplayFilters("filter-test", {
      // @ts-expect-error — intentional bad input
      bogus: true,
      thinking: false,
    });
    const f = getAgentDisplayFilters("filter-test")!;
    expect(f.thinking).toBe(false);
    expect((f as Record<string, unknown>).bogus).toBeUndefined();
  });

  it("null patch resets to defaults", () => {
    updateAgentDisplayFilters("filter-test", { bridge: false, synthetic: false });
    updateAgentDisplayFilters("filter-test", null);
    expect(getAgentDisplayFilters("filter-test")).toEqual(DISPLAY_FILTER_DEFAULTS);
  });

  it("isolates filters per agent", () => {
    seedAgent("filter-other");
    updateAgentDisplayFilters("filter-test", { thinking: false });
    expect(getAgentDisplayFilters("filter-other")).toEqual(DISPLAY_FILTER_DEFAULTS);
  });
});
