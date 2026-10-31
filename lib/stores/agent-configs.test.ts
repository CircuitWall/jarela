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
  getAgentToolCredentials,
  getAgentTierProportions,
  DISPLAY_FILTER_DEFAULTS,
  listAgentConfigs,
  duplicateAgentConfig,
} = await import("./agent-configs");
const { getDb } = await import("@/lib/db");
const { createThread } = await import("./threads");

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

describe("usage profiles", () => {
  it("preserves tuned sliders even if a legacy client updates only MBTI", () => {
    const fields = { id: "legacy-style", name: "Legacy style", identity: "", instructions: "", tools: [] };
    const tuned = {
      adaptive_persona_strength: 12, adaptive_empathy: 23,
      adaptive_expressiveness: 87, adaptive_verbosity: 91,
    };
    upsertAgentConfig({ ...fields, ...tuned, adaptive_mbti: "ISFJ" });
    expect(upsertAgentConfig({ ...fields, adaptive_mbti: "ENFP" })).toMatchObject(tuned);
    expect(upsertAgentConfig({ ...fields, usage_profile: "dev" })).toMatchObject(tuned);
    expect(duplicateAgentConfig(fields.id)).toMatchObject(tuned);
  });

  it("defaults to Everything and retains profile, tuned settings and filters across partial updates and duplication", () => {
    const created = seedAgent("profile-test");
    expect(created.usage_profile).toBe("custom");
    upsertAgentConfig({
      id: created.id, name: created.name, identity: "", instructions: "", tools: [],
      usage_profile: "home", adaptive_mbti: "ISFJ", citation_strictness: "standard",
    });
    updateAgentDisplayFilters(created.id, { thinking: false });
    const updated = upsertAgentConfig({
      id: created.id, name: "Renamed", identity: "", instructions: "", tools: [],
    });
    expect(updated.usage_profile).toBe("home");
    expect(updated.adaptive_mbti).toBe("ISFJ");
    expect(updated.citation_strictness).toBe("standard");
    expect(getAgentDisplayFilters(created.id)?.thinking).toBe(false);
    const copy = duplicateAgentConfig(created.id);
    expect(copy?.usage_profile).toBe("home");
    expect(copy?.adaptive_mbti).toBe("ISFJ");
    expect(getAgentDisplayFilters(copy!.id)?.thinking).toBe(false);
    expect(seedAgent("other-profile-test").usage_profile).toBe("custom");
  });
});

describe("warm summary limit", () => {
  it("defaults to 50 and persists custom values including zero", () => {
    const created = seedAgent("warm-summary-default");
    expect(created.warm_summary_limit).toBe(50);

    const updated = upsertAgentConfig({
      id: created.id,
      name: created.name,
      identity: created.identity,
      instructions: created.instructions,
      tools: [],
      warm_summary_limit: 0,
    });
    expect(updated.warm_summary_limit).toBe(0);

    const custom = upsertAgentConfig({
      id: created.id,
      name: created.name,
      identity: created.identity,
      instructions: created.instructions,
      tools: [],
      warm_summary_limit: 1_000,
    });
    expect(custom.warm_summary_limit).toBe(1_000);
  });
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

describe("agent tool_credentials (per-tool credential overrides)", () => {
  beforeEach(() => {
    seedAgent("tc-test");
  });

  it("returns an empty record when the column is null", () => {
    expect(getAgentToolCredentials(getAgentConfig("tc-test"))).toEqual({});
  });

  it("round-trips a { toolName: credentialId } map through upsert", () => {
    upsertAgentConfig({
      id: "tc-test",
      name: "tc-test",
      identity: "",
      instructions: "",
      tools: ["github_create_issue", "gmail_send"],
      tool_credentials: {
        github_create_issue: "integration-github-work",
        gmail_send: "integration-gmail-personal",
      },
    });
    expect(getAgentToolCredentials(getAgentConfig("tc-test")!)).toEqual({
      github_create_issue: "integration-github-work",
      gmail_send: "integration-gmail-personal",
    });
  });

  it("`undefined` on subsequent upsert keeps the existing map (PATCH-style)", () => {
    upsertAgentConfig({
      id: "tc-test", name: "tc-test", identity: "", instructions: "", tools: [],
      tool_credentials: { gmail_send: "integration-gmail-work" },
    });
    upsertAgentConfig({
      id: "tc-test", name: "tc-test", identity: "", instructions: "", tools: [],
      // tool_credentials omitted — must NOT clear the column.
    });
    expect(getAgentToolCredentials(getAgentConfig("tc-test")!)).toEqual({
      gmail_send: "integration-gmail-work",
    });
  });

  it("an empty input map clears the column (caller explicitly removed all overrides)", () => {
    upsertAgentConfig({
      id: "tc-test", name: "tc-test", identity: "", instructions: "", tools: [],
      tool_credentials: { gmail_send: "integration-gmail-work" },
    });
    upsertAgentConfig({
      id: "tc-test", name: "tc-test", identity: "", instructions: "", tools: [],
      tool_credentials: {},
    });
    expect(getAgentConfig("tc-test")!.tool_credentials).toBeNull();
    expect(getAgentToolCredentials(getAgentConfig("tc-test")!)).toEqual({});
  });

  it("filters non-string and blank entries from the input map", () => {
    upsertAgentConfig({
      id: "tc-test", name: "tc-test", identity: "", instructions: "", tools: [],
      tool_credentials: {
        gmail_send: "integration-gmail-work",
        github_create_issue: "",
        // @ts-expect-error — intentional bad input
        bogus: 42,
      },
    });
    expect(getAgentToolCredentials(getAgentConfig("tc-test")!)).toEqual({
      gmail_send: "integration-gmail-work",
    });
  });

  it("tolerates malformed JSON / non-object payloads in the column", () => {
    expect(getAgentToolCredentials({ tool_credentials: "not json" } as never)).toEqual({});
    expect(getAgentToolCredentials({ tool_credentials: "[]" } as never)).toEqual({});
    expect(getAgentToolCredentials({ tool_credentials: "null" } as never)).toEqual({});
    expect(getAgentToolCredentials({ tool_credentials: "" } as never)).toEqual({});
    expect(getAgentToolCredentials(null)).toEqual({});
    expect(getAgentToolCredentials(undefined)).toEqual({});
  });
});

describe("agent usage strategy", () => {
  it("round-trips the fast profile through persistence", () => {
    upsertAgentConfig({
      id: "fast-strategy-agent",
      name: "Fast Strategy Agent",
      identity: "",
      instructions: "",
      tools: [],
      usage_strategy: "fast",
    });

    expect(getAgentConfig("fast-strategy-agent")?.usage_strategy).toBe("fast");
  });
});

describe.each([
  { field: "anti_hallucination_mode", choices: ["off", "regex", "model"] },
  { field: "router_policy", choices: ["cheap", "fast", "balanced", "quality"] },
  { field: "usage_strategy", choices: ["cost_saving", "fast", "balanced", "high_reasoning"] },
] as const)("nullable agent override: $field", ({ field, choices }) => {
  const input = { id: `synthetic-override-${field}`, name: "Synthetic", identity: "", instructions: "", tools: [] };

  it("accepts every supported choice, keeps omitted values and clears explicit null", () => {
    for (const value of choices) {
      expect(upsertAgentConfig({ ...input, [field]: value })[field]).toBe(value);
      expect(upsertAgentConfig(input)[field]).toBe(value);
    }
    expect(upsertAgentConfig({ ...input, [field]: null })[field]).toBeNull();
    expect(upsertAgentConfig(input)[field]).toBeNull();
  });

  it("clears unsupported incoming values without changing other controls", () => {
    upsertAgentConfig({ ...input, [field]: choices[0], router_enabled: false, harness_id: null });
    for (const invalid of ["synthetic-unknown", "", " fast "]) {
      const row = upsertAgentConfig({ ...input, [field]: invalid });
      expect(row[field]).toBeNull();
      expect(row.router_enabled).toBe(0);
      expect(row.harness_id).toBeNull();
    }
  });

  it("preserves an existing legacy value on omission but validates an explicit resubmission", () => {
    upsertAgentConfig(input);
    getDb().prepare(`UPDATE agent_configs SET ${field}=? WHERE id=?`).run("synthetic-legacy", input.id);
    expect(upsertAgentConfig(input)[field]).toBe("synthetic-legacy");
    expect(upsertAgentConfig({ ...input, [field]: "synthetic-legacy" })[field]).toBeNull();
  });
});

describe("agent list ordering", () => {
  it("keeps the default first and sorts other agents by latest message time", () => {
    const db = getDb();
    const agents = [
      { id: "order-default", configAt: "2010-01-01T00:00:00.000Z", threadAt: "2010-01-01T00:00:00.000Z", messageAt: "2020-01-01T00:00:00.000Z", isDefault: true },
      { id: "order-config-recent", configAt: "2099-01-01T00:00:00.000Z", threadAt: "2099-01-01T00:00:00.000Z", messageAt: "2025-01-01T00:00:00.000Z", isDefault: false },
      { id: "order-message-recent", configAt: "2010-01-01T00:00:00.000Z", threadAt: "2010-01-01T00:00:00.000Z", messageAt: "2026-01-01T00:00:00.000Z", isDefault: false },
    ];

    for (const agent of agents) {
      seedAgent(agent.id);
      db.prepare("UPDATE agent_configs SET is_default=?, created_at=?, updated_at=? WHERE id=?")
        .run(agent.isDefault ? 1 : 0, agent.configAt, agent.configAt, agent.id);
      const thread = createThread(agent.id);
      db.prepare("UPDATE threads SET updated_at=? WHERE thread_id=?").run(agent.threadAt, thread.thread_id);
      db.prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at) VALUES (?,?, 'user', ?, ?)")
        .run(`message-${agent.id}`, thread.thread_id, agent.id, agent.messageAt);
    }

    const listed = listAgentConfigs()
      .filter((agent) => agents.some((candidate) => candidate.id === agent.id))
      .map((agent) => agent.id);

    expect(listed).toEqual([
      "order-default",
      "order-message-recent",
      "order-config-recent",
    ]);
  });
});
