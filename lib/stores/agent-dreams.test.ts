import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-dream-store-"));
process.env.JARELA_DB_DIR = root;

const { closeDb, getDb } = await import("@/lib/db");
const { deleteAgentConfig, upsertAgentConfig } = await import("./agent-configs");
const store = await import("./agent-dreams");

afterAll(() => {
  closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

function seedAgent(id: string, isDefault = false): void {
  upsertAgentConfig({
    id,
    name: id,
    identity: "",
    instructions: "",
    tools: [],
    is_default: isDefault,
  });
}

beforeEach(() => {
  store.__resetAgentDreamsForTests();
  getDb().prepare("DELETE FROM agent_configs").run();
  seedAgent("agent-a", true);
  seedAgent("agent-b");
});

describe("agent dream state", () => {
  it("creates default-enabled state and persists an opt-out", () => {
    const created = store.getOrCreateAgentDreamState("agent-a");
    expect(created.enabled).toBe(1);
    expect(created.last_light_dream_at).toBeNull();
    expect(created.last_light_boundary_seq).toBeNull();

    const disabled = store.setAgentDreamEnabled("agent-a", false);
    expect(disabled.enabled).toBe(0);
    expect(store.getAgentDreamState("agent-a")?.enabled).toBe(0);
    expect(store.listAgentDreamStates().map((row) => row.agent_id)).toEqual(["agent-a"]);
  });

  it("survives an agent config upsert because the tables have no cascading FK", () => {
    store.getOrCreateAgentDreamState("agent-a");
    store.setAgentDreamEnabled("agent-a", false);
    seedAgent("agent-a", true);
    expect(store.getAgentDreamState("agent-a")?.enabled).toBe(0);
  });

  it("records the light boundary and clears the previous error", () => {
    store.markDreamError("agent-a", "synthetic failure");
    store.markLightDreamAttempt("agent-a", "2026-01-01T00:00:00.000Z");
    store.markLightDream("agent-a", 42, "2026-01-01T00:01:00.000Z");
    const state = store.getAgentDreamState("agent-a")!;
    expect(state.last_light_dream_at).toBe("2026-01-01T00:01:00.000Z");
    expect(state.last_light_boundary_seq).toBe(42);
    expect(state.last_error).toBeNull();
  });

  it("prunes orphaned rows after the agent is deleted", () => {
    store.getOrCreateAgentDreamState("agent-b");
    store.createDreamRun({ agent_id: "agent-b", kind: "light" });
    deleteAgentConfig("agent-b");
    expect(store.pruneOrphanedDreamRows()).toBe(2);
    expect(store.getAgentDreamState("agent-b")).toBeNull();
    expect(store.listDreamRuns()).toEqual([]);
  });
});

describe("dream journal", () => {
  it("records runs, parses stats, and sums estimated tokens", () => {
    const run = store.createDreamRun({
      agent_id: "agent-a", kind: "light", started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(run.status).toBe("running");
    const finished = store.finishDreamRun(run.id, {
      status: "completed",
      summary: "Compacted 4 messages.",
      stats: { source_messages: 4 },
      estimated_input_tokens: 120,
      estimated_output_tokens: 30,
    })!;
    expect(finished.status).toBe("completed");
    expect(finished.finished_at).not.toBeNull();
    expect(store.parseDreamRunStats(finished)).toEqual({ source_messages: 4 });
    expect(store.sumDreamTokensSince("agent-a", "light", "2026-01-01T00:00:00.000Z")).toBe(150);
    expect(store.countDreamRunsSince("agent-a", "light", "2026-01-01T00:00:00.000Z")).toBe(1);
  });

  it("counts failed attempts against the daily limit and keeps their tokens", () => {
    const run = store.createDreamRun({
      agent_id: "agent-a", kind: "light", started_at: "2026-01-01T00:00:00.000Z",
    });
    store.finishDreamRun(run.id, {
      status: "failed", error: "synthetic", estimated_input_tokens: 50,
    });
    expect(store.countDreamRunsSince("agent-a", "light", "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(store.sumDreamTokensSince("agent-a", "light", "2026-01-01T00:00:00.000Z")).toBe(50);
  });

  it("handles missing runs, invalid stats, and oversized stats", () => {
    expect(store.getDreamRun("missing-run")).toBeNull();

    const run = store.createDreamRun({ agent_id: "agent-a", kind: "light" });
    getDb().prepare("UPDATE agent_dream_runs SET stats='not json' WHERE id=?").run(run.id);
    expect(store.parseDreamRunStats(store.getDreamRun(run.id)!)).toBeNull();

    store.finishDreamRun(run.id, {
      status: "completed",
      stats: { oversized: "x".repeat(70_000) },
    });
    const stored = store.getDreamRun(run.id)!;
    expect(store.parseDreamRunStats(stored)).toEqual({
      truncated: true,
      bytes: expect.any(Number),
    });
  });

  it("counts only failed attempts in the retry window", () => {
    const first = store.createDreamRun({ agent_id: "agent-a", kind: "light" });
    store.finishDreamRun(first.id, { status: "failed" });
    const second = store.createDreamRun({ agent_id: "agent-a", kind: "light" });
    store.finishDreamRun(second.id, { status: "failed" });
    const third = store.createDreamRun({ agent_id: "agent-a", kind: "light" });
    store.finishDreamRun(third.id, { status: "completed" });
    expect(store.countFailedDreamRunsSince("agent-a", "light", "2000-01-01T00:00:00.000Z")).toBe(2);
  });

  it("recovers interrupted runs and enforces retention", () => {
    const old = store.createDreamRun({
      agent_id: "agent-a", kind: "deep", started_at: "2020-01-01T00:00:00.000Z",
    });
    const recent = store.createDreamRun({
      agent_id: "agent-a", kind: "light", started_at: "2026-01-02T00:00:00.000Z",
    });
    expect(store.failInterruptedDreamRuns("2026-01-01T00:00:00.000Z")).toBe(1);
    expect(store.getDreamRun(old.id)?.status).toBe("failed");
    expect(store.getDreamRun(recent.id)?.status).toBe("running");

    store.finishDreamRun(recent.id, { status: "completed" });
    expect(store.pruneDreamRuns({ retentionDays: 30, now: new Date("2026-02-01T00:00:00.000Z") })).toBe(1);
    expect(store.getDreamRun(old.id)).toBeNull();
    expect(store.getDreamRun(recent.id)).not.toBeNull();
  });

  it("caps retained runs per agent", () => {
    for (let index = 0; index < 12; index += 1) {
      const run = store.createDreamRun({
        agent_id: "agent-a",
        kind: "light",
        started_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
      store.finishDreamRun(run.id, { status: "completed" });
    }
    expect(store.pruneDreamRuns({ keepPerAgent: 10, retentionDays: 365 })).toBe(2);
    expect(store.listDreamRuns({ agentId: "agent-a", limit: 100 })).toHaveLength(10);
  });
});

describe("budget windows", () => {
  it("computes the local day start", () => {
    const now = new Date(2026, 10, 26, 15, 30); // Thursday, local time
    const day = new Date(store.startOfLocalDay(now));
    expect(day.getHours()).toBe(0);
    expect(day.getDate()).toBe(26);
    expect(day.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});
