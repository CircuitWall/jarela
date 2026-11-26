import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMING_SETTINGS_DEFAULTS } from "@/api/dreaming";

const root = mkdtempSync(join(tmpdir(), "jarela-dreaming-"));
process.env.JARELA_DB_DIR = root;

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  reembed: vi.fn().mockResolvedValue(undefined),
  documentStatus: vi.fn(() => ({ running: false })),
  rewrite: vi.fn(),
  reclaim: vi.fn(),
  resolveModel: vi.fn(() => ({ provider: "mock", model_id: "mock", params: "{}" })),
  getProvider: vi.fn(),
  getRun: vi.fn(() => null),
  getActiveRunCount: vi.fn(() => 0),
  getQueueDepth: vi.fn(() => 0),
  isLocked: vi.fn(() => false),
}));

vi.mock("@/lib/crypto/master-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/master-key")>();
  return { ...actual, isMasterKeyLocked: mocks.isLocked };
});
vi.mock("@/lib/providers", () => ({ getProvider: mocks.getProvider }));
vi.mock("@/lib/agents/run-registry", () => ({
  getRun: mocks.getRun,
  getActiveRunCount: mocks.getActiveRunCount,
}));
vi.mock("@/lib/agents/run-queue", () => ({ getQueueDepth: mocks.getQueueDepth }));
vi.mock("@/lib/documents/lifecycle", () => ({
  getDocumentIndexMaintenanceStatus: mocks.documentStatus,
  rewriteLegacyDocumentEmbeddings: mocks.rewrite,
  reclaimIndexSpace: mocks.reclaim,
}));
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return { ...actual, reembedStaleVectors: mocks.reembed };
});
vi.mock("@/lib/stores/model-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stores/model-config")>();
  return { ...actual, resolveRunnableModelConfig: mocks.resolveModel };
});
vi.mock("@/lib/agents/warm-summary-background", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/warm-summary-background")>();
  return { ...actual, compactThreadWarmContext: mocks.compact };
});

const { closeDb, getDb } = await import("@/lib/db");
const {
  addMessage, getLatestForegroundUserMessage, getOrCreateAgentThread, getThread,
  setThreadContextPin, touchThread,
} = await import("@/lib/stores/threads");
const { getAgentConfig, upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const store = await import("@/lib/stores/agent-dreams");
const { getDreamingSettings, setDreamingSettings } = await import("@/lib/stores/app-settings");
const { getStoredMemoryValue, putMemory } = await import("@/lib/stores/memory");
const {
  CURRENT_STRUCTURED_MEMORY_VERSION, parseStructuredMemory,
} = await import("@/lib/memory/record");
const engine = await import("./dreaming");
const { runTrackedCompaction } = await import("./thread-compaction-state");

const OLD = "2026-01-01T00:00:00.000Z";

afterAll(() => {
  engine.__resetDreamingForTests();
  closeDb();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

function seedAgent(id: string, isDefault: boolean, overrides: Record<string, unknown> = {}): void {
  upsertAgentConfig({
    id,
    name: id,
    identity: "",
    instructions: "",
    tools: [],
    is_default: isDefault,
    ...overrides,
  });
}

function ageThread(threadId: string): void {
  getDb().prepare("UPDATE messages SET created_at=? WHERE thread_id=?").run(OLD, threadId);
  getDb().prepare("UPDATE threads SET updated_at=? WHERE thread_id=?").run(OLD, threadId);
}

function seedThread(agentId: string, isDefault = false, turns = 2): string {
  seedAgent(agentId, isDefault);
  const thread = getOrCreateAgentThread(agentId);
  for (let turn = 0; turn < turns; turn += 1) {
    addMessage(thread.thread_id, "user", `user ${turn}`);
    addMessage(thread.thread_id, "assistant", `assistant ${turn}`);
  }
  ageThread(thread.thread_id);
  return thread.thread_id;
}

function eligible(): ReturnType<typeof engine.evaluateLightDream> {
  return engine.evaluateLightDream(getAgentConfig("agent-a")!, getDreamingSettings());
}

function seedFact(
  key: string,
  content: string,
  confidence: "explicit" | "inferred" | "verified",
  expiresAt: string | null = null,
): void {
  putMemory("facts", key, {
    version: CURRENT_STRUCTURED_MEMORY_VERSION,
    kind: "preference",
    subject: "editor theme",
    content,
    tags: ["editor"],
    confidence,
    source: "conversation",
    observed_at: null,
    expires_at: expiresAt,
    summary: null,
    aliases: [],
    status: "active",
  });
}

function fact(key: string) {
  return parseStructuredMemory(getStoredMemoryValue("facts", key)!.value)!;
}

beforeEach(() => {
  engine.__resetDreamingForTests();
  store.__resetAgentDreamsForTests();
  getDb().prepare("DELETE FROM messages").run();
  getDb().prepare("DELETE FROM threads").run();
  getDb().prepare("DELETE FROM agent_configs").run();
  getDb().prepare("DELETE FROM memory_store WHERE namespace='facts'").run();
  setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS });
  mocks.compact.mockReset();
  mocks.reembed.mockReset().mockResolvedValue(undefined);
  mocks.documentStatus.mockReset().mockReturnValue({ running: false });
  mocks.rewrite.mockReset().mockResolvedValue({
    scanned: 2, rewritten: 2, skipped: 0, bytes_before: 100, bytes_after: 40, completed: true,
  });
  mocks.reclaim.mockReset().mockResolvedValue({
    auto_vacuum: "incremental", free_bytes_before: 4_096, free_bytes_after: 0,
    reclaimed_bytes: 4_096, completed: true,
  });
  mocks.resolveModel.mockReset().mockReturnValue({ provider: "mock", model_id: "mock", params: "{}" });
  mocks.getProvider.mockReset().mockReturnValue({
    chat: vi.fn(async () => ({
      stream: (async function* () { yield "Weekly consolidation note."; })(),
    })),
  });
  mocks.getRun.mockReset().mockReturnValue(null);
  mocks.getActiveRunCount.mockReset().mockReturnValue(0);
  mocks.getQueueDepth.mockReset().mockReturnValue(0);
  mocks.isLocked.mockReset().mockReturnValue(false);
});

describe("light-dream preflight", () => {
  it("is eligible after the idle threshold with enough new turns", () => {
    const threadId = seedThread("agent-a", true);
    const latestUser = getLatestForegroundUserMessage(threadId)!;
    const evaluation = eligible();
    expect(evaluation.readiness).toEqual({ eligible: true, reason: null });
    expect(evaluation.candidate?.boundarySeq).toBe(latestUser.seq);
  });

  it("skips when the 3-hour compaction already moved the boundary", () => {
    const threadId = seedThread("agent-a", true);
    const latestUser = getLatestForegroundUserMessage(threadId)!;
    setThreadContextPin(threadId, latestUser.created_at, latestUser.seq);
    expect(eligible().readiness).toEqual({ eligible: false, reason: "too_few_turns" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("skips a second dream in the same idle window", () => {
    seedThread("agent-a", true);
    store.markLightDream("agent-a", 4);
    expect(eligible().readiness).toEqual({ eligible: false, reason: "already_dreamed" });
  });

  it("skips a failed retry inside the cooldown", () => {
    seedThread("agent-a", true);
    store.markLightDreamAttempt("agent-a");
    expect(eligible().readiness).toEqual({ eligible: false, reason: "retry_cooldown" });
  });

  it("skips when the agent is busy, locked, or has no model", () => {
    seedThread("agent-a", true);
    mocks.getRun.mockReturnValueOnce({ status: "running" });
    expect(eligible().readiness.reason).toBe("active_run");
    mocks.isLocked.mockReturnValueOnce(true);
    expect(eligible().readiness.reason).toBe("locked");
    mocks.resolveModel.mockReturnValueOnce(null);
    expect(eligible().readiness.reason).toBe("no_model");
  });

  it("skips when warm summaries or the per-agent opt-in are disabled", () => {
    seedThread("agent-a", true);
    store.setAgentDreamEnabled("agent-a", false);
    expect(eligible().readiness.reason).toBe("agent_disabled");
    store.setAgentDreamEnabled("agent-a", true);

    upsertAgentConfig({
      id: "agent-a", name: "agent-a", identity: "", instructions: "", tools: [],
      is_default: true, warm_summary_limit: 0,
    });
    expect(eligible().readiness.reason).toBe("summary_disabled");
  });

  it("enforces the daily run limit and estimated-token budget", () => {
    seedThread("agent-a", true);
    for (let index = 0; index < DREAMING_SETTINGS_DEFAULTS.light_max_per_day; index += 1) {
      const run = store.createDreamRun({ agent_id: "agent-a", kind: "light" });
      store.finishDreamRun(run.id, { status: "completed" });
    }
    expect(eligible().readiness.reason).toBe("daily_limit");

    store.__resetAgentDreamsForTests();
    setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS, light_daily_token_budget: 1 });
    const run = store.createDreamRun({ agent_id: "agent-a", kind: "light" });
    store.finishDreamRun(run.id, { status: "completed", estimated_input_tokens: 10 });
    expect(eligible().readiness.reason).toBe("budget_exhausted");
  });

  it("skips when dreaming is globally disabled or the agent has no thread", () => {
    setDreamingSettings({ enabled: false });
    seedThread("agent-a", true);
    expect(eligible().readiness.reason).toBe("disabled");

    setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS });
    getDb().prepare("DELETE FROM threads").run();
    seedAgent("agent-a", true);
    expect(eligible().readiness.reason).toBe("no_thread");
  });

  it("skips a thread with no messages and one with an in-progress user turn", () => {
    seedAgent("agent-a", true);
    getOrCreateAgentThread("agent-a");
    expect(eligible().readiness.reason).toBe("no_messages");

    const threadId = seedThread("agent-a", true);
    addMessage(threadId, "user", "still sending", null, null, null, "in_progress");
    expect(eligible().readiness.reason).toBe("queued_turn");
  });

  it("skips while another compaction holds the thread", async () => {
    const threadId = seedThread("agent-a", true);
    let release: (() => void) | undefined;
    const pending = runTrackedCompaction(threadId, "dream", 1, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    try {
      expect(eligible().readiness.reason).toBe("compaction_in_flight");
    } finally {
      release?.();
      await pending;
    }
  });

  it("stops retrying after two failed light attempts in the same idle window", () => {
    const threadId = seedThread("agent-a", true);
    const latest = getLatestForegroundUserMessage(threadId)!;
    for (let index = 0; index < 2; index += 1) {
      const run = store.createDreamRun({
        agent_id: "agent-a", kind: "light", started_at: latest.created_at,
      });
      store.finishDreamRun(run.id, { status: "failed", error: "synthetic failure" });
    }
    expect(eligible().readiness.reason).toBe("retry_cooldown");
  });

  it("skips when the estimated light budget would be exceeded", () => {
    seedThread("agent-a", true);
    setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS, light_daily_token_budget: 1 });
    expect(eligible().readiness.reason).toBe("budget_exhausted");
  });

  it("does not dream a thread with only one exchange", () => {
    seedThread("agent-a", true, 1);
    expect(eligible().readiness.reason).toBe("too_few_turns");
  });

  it("treats newer bridge activity as not idle", () => {
    const threadId = seedThread("agent-a", true);
    addMessage(threadId, "user", "bridge message", null, "bridge");
    expect(eligible().readiness.reason).toBe("not_idle");
  });
});

describe("light-dream execution", () => {
  it("runs through the dream compaction kind and records the boundary", async () => {
    const threadId = seedThread("agent-a", true);
    const latestUser = getLatestForegroundUserMessage(threadId)!;
    mocks.compact.mockResolvedValue({
      boundary: OLD,
      boundarySeq: 4,
      summary: "recap",
      sourceMessages: 4,
      sourceChars: 80,
      topics: [],
      channels: [],
    });

    const started = engine.startDream("agent-a", "light", { force: true });
    expect(started.started).toBe(true);
    await engine.waitForDreaming();

    expect(mocks.compact).toHaveBeenCalledOnce();
    const [, boundarySeq, options] = mocks.compact.mock.calls[0];
    expect(boundarySeq).toBe(latestUser.seq);
    expect(options).toMatchObject({
      expectedHotSinceSeq: null,
      alignTopicBoundary: true,
      allowEmptySummary: false,
    });
    const run = store.listDreamRuns({ agentId: "agent-a" })[0];
    expect(run.status).toBe("completed");
    expect(run.estimated_input_tokens).toBe(20);
    expect(run.estimated_output_tokens).toBe(2);
    expect(store.getAgentDreamState("agent-a")).toMatchObject({
      last_light_boundary_seq: 4,
      last_error: null,
    });
  });

  it("serializes dreams globally", async () => {
    seedThread("agent-a", true);
    let resolveCompact: ((value: unknown) => void) | undefined;
    mocks.compact.mockReturnValue(new Promise((resolve) => { resolveCompact = resolve; }));

    expect(engine.startDream("agent-a", "light", { force: true }).started).toBe(true);
    expect(engine.startDream("agent-a", "light", { force: true })).toEqual({
      started: false,
      reason: "dream_running",
    });
    await vi.waitFor(() => expect(mocks.compact).toHaveBeenCalledOnce());
    resolveCompact?.({
      boundary: OLD, boundarySeq: 4, summary: "recap", sourceMessages: 4, sourceChars: 40, topics: [], channels: [],
    });
    await engine.waitForDreaming();
  });

  it("records a skipped run when the compaction resolves as a no-op", async () => {
    const threadId = seedThread("agent-a", true);
    const latestUser = getLatestForegroundUserMessage(threadId)!;
    mocks.compact.mockImplementation(async () => {
      getDb().prepare(
        `UPDATE threads SET hot_since_seq=?, warm_summary_before_seq=?,
           warm_summary=?, warm_summary_computed_at=? WHERE thread_id=?`,
      ).run(
        latestUser.seq, latestUser.seq, "recap", new Date().toISOString(), threadId,
      );
      return null;
    });

    expect(engine.startDream("agent-a", "light", { force: true }).started).toBe(true);
    await engine.waitForDreaming();

    const run = store.listDreamRuns({ agentId: "agent-a" })[0];
    expect(run.status).toBe("skipped");
    expect(run.stats).toContain("no_op");
    expect(store.getAgentDreamState("agent-a")?.last_light_boundary_seq).toBe(latestUser.seq);
  });

  it("rejects an unknown agent before starting", () => {
    expect(engine.startDream("missing-agent", "light")).toEqual({
      started: false,
      reason: "agent_not_found",
    });
  });

  it("records a failure without touching the last successful boundary", async () => {
    seedThread("agent-a", true);
    mocks.compact.mockRejectedValue(new Error("provider down"));
    engine.startDream("agent-a", "light", { force: true });
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" })[0];
    expect(run.status).toBe("failed");
    expect(run.error).toContain("provider down");
    expect(store.getAgentDreamState("agent-a")?.last_error).toContain("provider down");
    expect(store.getAgentDreamState("agent-a")?.last_light_dream_at).toBeNull();
  });
});

describe("deep-dream scheduling", () => {
  function makeDeepDue(agentId: string): void {
    const state = store.getOrCreateAgentDreamState(agentId);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    getDb().prepare("UPDATE agent_dream_state SET created_at=?, updated_at=? WHERE agent_id=?")
      .run(old, old, agentId);
    expect(state.agent_id).toBe(agentId);
  }

  it("is not due before the first weekly slot, and belongs only to the default agent", () => {
    seedThread("agent-a", true);
    seedAgent("agent-b", false);
    const settings = getDreamingSettings();
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, settings).readiness.reason)
      .toBe("deep_not_due");
    expect(engine.evaluateDeepDream(getAgentConfig("agent-b")!, settings).readiness.reason)
      .toBe("not_default_agent");
  });

  it("skips deep work when globally or weekly disabled", () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS, enabled: false });
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("disabled");
    setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS, deep_enabled: false });
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("disabled");
  });

  it("skips deep work when locked, busy, opted out, or retrying", () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    mocks.isLocked.mockReturnValueOnce(true);
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("locked");

    mocks.getActiveRunCount.mockReturnValueOnce(1);
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("active_run");

    store.setAgentDreamEnabled("agent-a", false);
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("agent_disabled");
    store.setAgentDreamEnabled("agent-a", true);

    store.markDeepDreamAttempt("agent-a");
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("retry_cooldown");
  });

  it("skips deep work while the user is recently active, but manual force bypasses it", () => {
    const threadId = seedThread("agent-a", true);
    makeDeepDue("agent-a");
    addMessage(threadId, "user", "current foreground activity");
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("not_idle");
    expect(engine.evaluateDeepDream(
      getAgentConfig("agent-a")!,
      getDreamingSettings(),
      new Date(),
      { force: true },
    ).readiness.eligible).toBe(true);
  });

  it("does not treat automation traffic as foreground user activity", () => {
    const threadId = seedThread("agent-a", true);
    makeDeepDue("agent-a");
    addMessage(threadId, "assistant", "scheduled task ran", null, "scheduled_task");
    touchThread(threadId); // automation bumps threads.updated_at
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.eligible)
      .toBe(true);
  });

  it("does not run deep maintenance twice within seven days", () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    const lastRun = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    getDb().prepare("UPDATE agent_dream_state SET last_deep_dream_at=? WHERE agent_id=?")
      .run(lastRun, "agent-a");
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("deep_not_due");
  });

  it("runs the deterministic phases and the weekly note when due and idle", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");

    expect(await engine.runDreamingSweep()).toBe(true);
    await engine.waitForDreaming();

    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    expect(run.status).toBe("completed");
    expect(run.summary).toContain("Memory:");
    expect(stats.memory).toBeTruthy();
    expect(stats.review).toMatchObject({ text: "Weekly consolidation note." });
    expect(mocks.reembed).toHaveBeenCalledOnce();
    expect(mocks.rewrite).toHaveBeenCalledOnce();
    expect(mocks.reclaim).toHaveBeenCalledOnce();
    expect(store.getAgentDreamState("agent-a")?.last_deep_dream_at).not.toBeNull();
  });

  it("skips the model note when the weekly token budget is exhausted", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    setDreamingSettings({ deep_weekly_token_budget: 1 });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    expect(run.status).toBe("completed");
    expect(stats.review).toBeUndefined();
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it("merges near-duplicate facts through an explicit validated model call", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact("theme-a", "The user prefers the dark color theme for the editor.", "explicit");
    seedFact("theme-b", "The user prefers the dark color theme for the code editor.", "inferred");
    const mergedContent = "The user prefers the dark color theme for the code editor.";
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
        const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
        const text = system.includes("memory consolidation step")
          ? JSON.stringify({
            merge: true,
            survivor_key: "theme-a",
            content: mergedContent,
            tags: ["editor", "theme"],
            summary: null,
            reason: "same preference",
          })
          : "Weekly consolidation note.";
        return { stream: (async function* () { yield text; })() };
      }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();

    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    const merges = stats.merges as {
      enabled: boolean; considered: number; merged: number; archived_records: number;
    };
    expect(run.status).toBe("completed");
    expect(merges).toMatchObject({ enabled: true, considered: 1, merged: 1, archived_records: 1 });
    expect(fact("theme-a").content).toBe(mergedContent);
    expect(fact("theme-a").confidence).toBe("inferred");
    expect(fact("theme-a").tags).toEqual(expect.arrayContaining(["editor", "theme"]));
    expect(fact("theme-b").status).toBe("archived");
    expect(run.estimated_input_tokens).toBeGreaterThan(0);
    expect(run.estimated_output_tokens).toBeGreaterThan(0);
  });

  it("keeps both records when the merge model declines", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact("theme-a", "The user prefers the dark color theme for the editor.", "explicit");
    seedFact("theme-b", "The user prefers the dark color theme for the code editor.", "inferred");
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
        const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
        const text = system.includes("memory consolidation step")
          ? JSON.stringify({ merge: false, reason: "different scopes" })
          : "Weekly consolidation note.";
        return { stream: (async function* () { yield text; })() };
      }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();

    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    const merges = stats.merges as { merged: number; skipped: number };
    expect(merges).toMatchObject({ merged: 0, skipped: 1 });
    expect(fact("theme-a").status).toBe("active");
    expect(fact("theme-b").status).toBe("active");
  });

  it("rejects an invalid merge response and keeps both records", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact("theme-a", "The user prefers the dark color theme for the editor.", "explicit");
    seedFact("theme-b", "The user prefers the dark color theme for the code editor.", "inferred");
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
        const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
        return {
          stream: (async function* () {
            yield system.includes("memory consolidation step") ? "not json" : "Weekly consolidation note.";
          })(),
        };
      }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    expect((stats.merges as { merged: number; skipped: number })).toMatchObject({ merged: 0, skipped: 1 });
    expect(fact("theme-a").status).toBe("active");
    expect(fact("theme-b").status).toBe("active");
  });

  it("rejects a merge whose survivor key is not in the group", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact("theme-a", "The user prefers the dark color theme for the editor.", "explicit");
    seedFact("theme-b", "The user prefers the dark color theme for the code editor.", "inferred");
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
        const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
        const text = system.includes("memory consolidation step")
          ? JSON.stringify({ merge: true, survivor_key: "missing", content: "merged" })
          : "Weekly consolidation note.";
        return { stream: (async function* () { yield text; })() };
      }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    expect((store.parseDreamRunStats(run)!.merges as { merged: number }).merged).toBe(0);
    expect(fact("theme-a").content).toBe("The user prefers the dark color theme for the editor.");
    expect(fact("theme-b").status).toBe("active");
  });

  it("does not merge records with conflicting expiries", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact(
      "theme-a",
      "The user prefers the dark color theme for the editor.",
      "explicit",
      "2026-12-01T00:00:00.000Z",
    );
    seedFact(
      "theme-b",
      "The user prefers the dark color theme for the code editor.",
      "inferred",
      "2027-01-01T00:00:00.000Z",
    );
    const chat = vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
      const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
      return {
        stream: (async function* () {
          yield system.includes("memory consolidation step")
            ? JSON.stringify({ merge: true, survivor_key: "theme-a", content: "merged" })
            : "Weekly consolidation note.";
        })(),
      };
    });
    mocks.getProvider.mockReturnValue({ chat });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    expect(chat.mock.calls.some(([, messages]) =>
      String(messages[0]?.content).includes("memory consolidation step"))).toBe(false);
    expect(fact("theme-a").expires_at).toBe("2026-12-01T00:00:00.000Z");
    expect(fact("theme-b").status).toBe("active");
  });

  it("skips the merge model when the weekly token budget is already exhausted", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact("theme-a", "The user prefers the dark color theme for the editor.", "explicit");
    seedFact("theme-b", "The user prefers the dark color theme for the code editor.", "inferred");
    setDreamingSettings({ ...DREAMING_SETTINGS_DEFAULTS, deep_weekly_token_budget: 1 });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    expect((store.parseDreamRunStats(run)!.merges as { merged: number }).merged).toBe(0);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(fact("theme-a").status).toBe("active");
    expect(fact("theme-b").status).toBe("active");
  });

  it("records provider failures in the merge phase without failing the dream", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    seedFact("theme-a", "The user prefers the dark color theme for the editor.", "explicit");
    seedFact("theme-b", "The user prefers the dark color theme for the code editor.", "inferred");
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
        const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
        if (system.includes("memory consolidation step")) throw new Error("merge provider down");
        return { stream: (async function* () { yield "Weekly consolidation note."; })() };
      }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    expect(run.status).toBe("completed");
    expect((stats.merges as { errors: string[] }).errors[0]).toContain("merge provider down");
    expect(stats.review).toBeTruthy();
    expect(fact("theme-a").status).toBe("active");
    expect(fact("theme-b").status).toBe("active");
  });

  it("skips a truncated near-duplicate group instead of merging only part of it", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    for (let index = 0; index < 6; index += 1) {
      seedFact(
        `theme-${index}`,
        `The user prefers the dark color theme for the code editor ${index}.`,
        "inferred",
      );
    }
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async (_modelId: string, messages: Array<{ content: unknown }>) => {
        const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
        return {
          stream: (async function* () {
            yield system.includes("memory consolidation step")
              ? JSON.stringify({ merge: true, survivor_key: "theme-0", content: "merged" })
              : "Weekly consolidation note.";
          })(),
        };
      }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const merges = store.parseDreamRunStats(run)!.merges as { merged: number; groups: Array<{ reason?: string }> };
    expect(merges.merged).toBe(0);
    expect(merges.groups.some((group) => group.reason === "group_truncated")).toBe(true);
  });

  it("isolates embedding, document, and weekly-review failures", async () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    mocks.reembed.mockRejectedValueOnce(new Error("embedding down"));
    mocks.rewrite.mockRejectedValueOnce(new Error("rewrite down"));
    mocks.reclaim.mockRejectedValueOnce(new Error("reclaim down"));
    mocks.getProvider.mockReturnValue({
      chat: vi.fn(async () => { throw new Error("review down"); }),
    });

    await engine.runDreamingSweep();
    await engine.waitForDreaming();
    const run = store.listDreamRuns({ agentId: "agent-a" }).find((candidate) => candidate.kind === "deep")!;
    const stats = store.parseDreamRunStats(run)!;
    expect(run.status).toBe("completed");
    expect(JSON.stringify(stats)).toContain("embedding refresh");
    expect(JSON.stringify(stats)).toContain("document embeddings");
    expect(JSON.stringify(stats)).toContain("reclaim");
    expect(JSON.stringify(stats)).toContain("weekly review");
  });

  it("skips deep maintenance while document maintenance is running", () => {
    seedThread("agent-a", true);
    makeDeepDue("agent-a");
    mocks.documentStatus.mockReturnValueOnce({ running: true });
    expect(engine.evaluateDeepDream(getAgentConfig("agent-a")!, getDreamingSettings()).readiness.reason)
      .toBe("documents_busy");
  });
});

describe("overview", () => {
  it("reports settings, readiness, and the journal", () => {
    seedThread("agent-a", true);
    const overview = engine.getDreamingOverview();
    expect(overview.settings.enabled).toBe(true);
    expect(overview.agents.map((agent) => agent.agent_id)).toEqual(["agent-a"]);
    expect(overview.agents[0].light.eligible).toBe(true);
    expect(overview.runs).toEqual([]);
  });
});
