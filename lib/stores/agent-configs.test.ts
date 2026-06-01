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
  getAgentConfig,
  getAgentDisplayFilters,
  updateAgentDisplayFilters,
  getAgentTools,
  getAgentTierProportions,
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

describe("getAgentTools", () => {
  it("returns the agent's tool list", () => {
    upsertAgentConfig({
      id: "tools-test", name: "tools-test", identity: "", instructions: "",
      tools: ["file_read", "memory_write"],
    });
    const cfg = { tools: JSON.stringify(["file_read", "memory_write"]) };
    expect(getAgentTools(cfg)).toEqual(["file_read", "memory_write"]);
  });

  it("returns [] for null/undefined cfg", () => {
    expect(getAgentTools(null)).toEqual([]);
    expect(getAgentTools(undefined)).toEqual([]);
  });

  it("returns [] for blank or malformed JSON", () => {
    expect(getAgentTools({ tools: "" })).toEqual([]);
    expect(getAgentTools({ tools: "not json" })).toEqual([]);
    expect(getAgentTools({ tools: "{\"not\":\"array\"}" })).toEqual([]);
  });

  it("filters non-string entries", () => {
    expect(getAgentTools({ tools: JSON.stringify(["a", 1, null, "b", ""]) })).toEqual(["a", "b"]);
  });
});

describe("agent context-tier proportions (ADR-0043)", () => {
  beforeEach(() => {
    seedAgent("tier-test");
    upsertAgentConfig({
      id: "tier-test",
      name: "tier-test",
      identity: "",
      instructions: "",
      tools: [],
      context_tier_proportions: null,
    });
  });

  it("returns null for a fresh agent — no override means inherit from model", () => {
    const row = getAgentConfig("tier-test")!;
    expect(getAgentTierProportions(row)).toBeNull();
  });

  it("round-trips raw weights without forcing the user to sum to 100", () => {
    upsertAgentConfig({
      id: "tier-test",
      name: "tier-test",
      identity: "",
      instructions: "",
      tools: [],
      context_tier_proportions: { hot: 6, warm: 2.5, facts: 1.5 },
    });
    expect(getAgentTierProportions(getAgentConfig("tier-test")!)).toEqual({
      hot: 6,
      warm: 2.5,
      facts: 1.5,
    });
  });

  it("treats `null` on upsert as a clear-the-override action", () => {
    upsertAgentConfig({
      id: "tier-test",
      name: "tier-test",
      identity: "",
      instructions: "",
      tools: [],
      context_tier_proportions: { hot: 7, warm: 2, facts: 1 },
    });
    upsertAgentConfig({
      id: "tier-test",
      name: "tier-test",
      identity: "",
      instructions: "",
      tools: [],
      context_tier_proportions: null,
    });
    expect(getAgentTierProportions(getAgentConfig("tier-test")!)).toBeNull();
  });

  it("rejects payloads where the three fields don't add up to a positive sum", () => {
    upsertAgentConfig({
      id: "tier-test",
      name: "tier-test",
      identity: "",
      instructions: "",
      tools: [],
      // Stored as JSON, then parsed back. After clamping negatives to 0 the
      // sum is 0 — `getAgentTierProportions` returns null and the caller
      // falls back to the model default.
      context_tier_proportions: { hot: 0, warm: -1, facts: 0 },
    });
    expect(getAgentTierProportions(getAgentConfig("tier-test")!)).toBeNull();
  });

  it("ignores malformed JSON in the column", () => {
    expect(
      getAgentTierProportions({ context_tier_proportions: "not json" } as never),
    ).toBeNull();
    expect(
      getAgentTierProportions({ context_tier_proportions: "" } as never),
    ).toBeNull();
    expect(
      getAgentTierProportions({ context_tier_proportions: null } as never),
    ).toBeNull();
  });
});
