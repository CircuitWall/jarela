import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process. Migrations create the relevant tables on
// first getDb() call. Pin JARELA_DB_DIR before any module under test imports
// the db module so they share the same dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-proposals-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { applyAction } = await import("./proposals");
const { listAllHarnesses, getHarness, createCustomHarness, deleteCustomHarness } = await import("@/lib/stores/harnesses");
const { upsertAgentConfig, getAgentConfig } = await import("@/lib/stores/agent-configs");
const { DEFAULT_HARNESS_ID } = await import("./harness/types");

function seedAgent(id: string) {
  upsertAgentConfig({
    id,
    name: id,
    identity: "test agent",
    instructions: "be helpful",
    tools: [],
  });
}

describe("applyAction(upsert_harness)", () => {
  beforeEach(() => {
    // Wipe any custom harnesses lingering from a prior test in this file so
    // each case starts from a clean slate (built-ins are never touched).
    for (const h of listAllHarnesses()) {
      if (!h.builtin) deleteCustomHarness(h.id);
    }
  });

  it("creates a custom harness when no id is provided", async () => {
    const result = await applyAction("upsert_harness", {
      name: "Strict Citations",
      description: "Tightens the citation section",
      sections: {
        citation: { enabled: true, body: "MANDATORY: cite every claim." },
      },
    });

    expect(result.ok).toBe(true);
    const detail = result.detail as { id: string; name: string; created: boolean };
    expect(detail.created).toBe(true);
    expect(detail.id.startsWith("custom:")).toBe(true);
    expect(detail.name).toBe("Strict Citations");

    // Round-trip via store: the harness is now visible and has the body we sent.
    const stored = getHarness(detail.id)!;
    expect(stored.builtin).toBe(false);
    expect(stored.sections.citation.body).toBe("MANDATORY: cite every claim.");
    // Sections we didn't pass come back with defaults (enabled=true, empty body).
    expect(stored.sections.capabilities.enabled).toBe(true);
  });

  it("edits an existing custom harness when its id is provided", async () => {
    const seeded = createCustomHarness({
      name: "Original",
      sections: { capabilities: { enabled: true, body: "old body" } },
    });

    const result = await applyAction("upsert_harness", {
      id: seeded.id,
      name: "Renamed",
      sections: { capabilities: { enabled: true, body: "new body" } },
    });

    expect(result.ok).toBe(true);
    const detail = result.detail as { id: string; name: string; created: boolean };
    expect(detail.created).toBe(false);
    expect(detail.id).toBe(seeded.id);

    const after = getHarness(seeded.id)!;
    expect(after.name).toBe("Renamed");
    expect(after.sections.capabilities.body).toBe("new body");
  });

  it("rejects edits to built-in harness ids", async () => {
    const result = await applyAction("upsert_harness", {
      id: DEFAULT_HARNESS_ID,
      name: "I'm trying to mutate the default",
      sections: {},
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("built-in harnesses are read-only");
  });

  it("rejects ids that are neither built-in nor custom", async () => {
    const result = await applyAction("upsert_harness", {
      id: "garbage:not-a-real-prefix",
      name: "x",
      sections: {},
    });
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/must start with "custom:"/);
  });

  it("rejects unknown section keys to catch payload typos at the boundary", async () => {
    const result = await applyAction("upsert_harness", {
      name: "Bad sections",
      sections: { typo_section: { enabled: true, body: "x" } } as unknown,
    });
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/unknown harness section/);
  });

  it("requires a name when creating", async () => {
    const result = await applyAction("upsert_harness", {
      sections: { citation: { enabled: true, body: "" } },
    });
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/name required/);
  });

  it("returns 'not found' when editing a custom id that doesn't exist", async () => {
    const result = await applyAction("upsert_harness", {
      id: "custom:11111111-1111-1111-1111-111111111111",
      name: "Doesn't matter",
      sections: {},
    });
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/not found/);
  });
});

describe("applyAction(update_agent) with harness_id", () => {
  it("updates instructions so an approved proposal can change future system prompts", async () => {
    seedAgent("agent-update-instructions");

    const result = await applyAction("update_agent", {
      agent_id: "agent-update-instructions",
      instructions: "Prefer direct answers and persist useful behavior changes.",
    });

    expect(result.ok).toBe(true);
    expect((result.detail as { instructions_changed: boolean }).instructions_changed).toBe(true);
    expect(getAgentConfig("agent-update-instructions")!.instructions).toBe(
      "Prefer direct answers and persist useful behavior changes.",
    );
  });

  it("sets harness_id to a valid custom harness", async () => {
    seedAgent("agent-set-harness");
    const harness = createCustomHarness({
      name: "Bound harness",
      sections: { capabilities: { enabled: true, body: "x" } },
    });

    const result = await applyAction("update_agent", {
      agent_id: "agent-set-harness",
      harness_id: harness.id,
    });
    expect(result.ok).toBe(true);
    expect((result.detail as { harness_id_changed: boolean }).harness_id_changed).toBe(true);
    expect(getAgentConfig("agent-set-harness")!.harness_id).toBe(harness.id);
  });

  it("clears harness_id (inherit global default) when null is passed", async () => {
    seedAgent("agent-clear-harness");
    const harness = createCustomHarness({
      name: "To be cleared",
      sections: {},
    });
    upsertAgentConfig({
      id: "agent-clear-harness",
      name: "agent-clear-harness",
      identity: "test agent",
      instructions: "be helpful",
      tools: [],
      harness_id: harness.id,
    });
    expect(getAgentConfig("agent-clear-harness")!.harness_id).toBe(harness.id);

    const result = await applyAction("update_agent", {
      agent_id: "agent-clear-harness",
      harness_id: null,
    });
    expect(result.ok).toBe(true);
    expect(getAgentConfig("agent-clear-harness")!.harness_id).toBeNull();
  });

  it("rejects an unknown harness_id without writing", async () => {
    seedAgent("agent-bad-harness");
    const before = getAgentConfig("agent-bad-harness")!.harness_id;
    const result = await applyAction("update_agent", {
      agent_id: "agent-bad-harness",
      harness_id: "custom:does-not-exist",
    });
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/not found/);
    // Agent row untouched.
    expect(getAgentConfig("agent-bad-harness")!.harness_id).toBe(before);
  });

  it("preserves existing harness_id when the field is omitted (undefined = keep)", async () => {
    seedAgent("agent-keep-harness");
    const harness = createCustomHarness({ name: "Sticky", sections: {} });
    upsertAgentConfig({
      id: "agent-keep-harness",
      name: "agent-keep-harness",
      identity: "test agent",
      instructions: "be helpful",
      tools: [],
      harness_id: harness.id,
    });

    const result = await applyAction("update_agent", {
      agent_id: "agent-keep-harness",
      identity: "edited identity",
      // harness_id intentionally omitted
    });
    expect(result.ok).toBe(true);
    expect(getAgentConfig("agent-keep-harness")!.harness_id).toBe(harness.id);
    expect(getAgentConfig("agent-keep-harness")!.identity).toBe("edited identity");
  });
});

describe("applyAction(update_agent) instructions_append", () => {
  it("appends to existing instructions without overwriting them", async () => {
    seedAgent("agent-append-1");

    const result = await applyAction("update_agent", {
      agent_id: "agent-append-1",
      instructions_append: "\n\nAlways end replies with a summary.",
    });

    expect(result.ok).toBe(true);
    expect((result.detail as { instructions_changed: boolean }).instructions_changed).toBe(true);
    expect(getAgentConfig("agent-append-1")!.instructions).toBe(
      "be helpful\n\nAlways end replies with a summary.",
    );
  });

  it("rejects a payload that provides both instructions and instructions_append", async () => {
    seedAgent("agent-append-conflict");

    const result = await applyAction("update_agent", {
      agent_id: "agent-append-conflict",
      instructions: "completely new",
      instructions_append: "\n\nExtra rule.",
    });

    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/not both/);
    // Agent row must be untouched.
    expect(getAgentConfig("agent-append-conflict")!.instructions).toBe("be helpful");
  });
});
