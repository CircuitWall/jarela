import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-history-window-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.JARELA_WARM_SUMMARY_BUDGET_MS = "100";
process.env.JARELA_RECALL_BUDGET_MS = "100";

const chatSpy = vi.fn();
vi.mock("@/lib/providers", () => ({
  getProvider: () => ({
    chat: (modelId: string, messages: unknown, params: unknown) =>
      chatSpy(modelId, messages, params),
  }),
}));

// Facts tier hits recall(); addMessage hits embedOne(). Stub both inert so
// they don't introduce noise into the warm-tier assertions below. recall is
// a spy so individual tests can override it (e.g. to simulate a hang).
const recallSpy = vi.fn<(query: string, k: number) => Promise<unknown[]>>(async () => []);
vi.mock("@/lib/embeddings", () => ({
  recall: (query: string, k: number) => recallSpy(query, k),
  embed: vi.fn(async () => null),
  embedOne: vi.fn(async () => null),
  embedBestEffort: vi.fn(async () => ({ vectors: [], error: null, failed: 0 })),
  cosine: () => 0,
}));

const { addMessage, createThread, deleteThread, getThread, listThreads, setThreadContextPin } =
  await import("@/lib/stores/threads");
const { buildHistoryWindow } = await import("./history-window");
import type { AgentConfigRow } from "@/lib/stores/agent-configs";

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Minimal agent config — buildHistoryWindow only reads history_limit and
// history_window_hours, so the rest is fill.
function agentCfg(overrides: Partial<AgentConfigRow> = {}): AgentConfigRow {
  return {
    id: "test-agent",
    name: "Test",
    icon: null,
    identity: "",
    instructions: "",
    tools: "[]",
    model_config_name: null,
    is_default: 0,
    history_limit: 50,
    history_window_hours: 8,
    never_reply: 0,
    adaptive_persona_enabled: 0,
    adaptive_persona_strength: 0,
    adaptive_empathy: 50,
    adaptive_expressiveness: 50,
    adaptive_verbosity: 50,
    adaptive_mbti: "INTJ",
    voice_enabled: 0,
    voice_model: "",
    voice_name: "",
    voice_stt_model: "",
    voice_auto_speak: 0,
    display_filters: null,
    harness_id: null,
    delegate_targets: null,
    context_tier_proportions: null,
    anti_hallucination_mode: null,
    ...overrides,
  } as AgentConfigRow;
}

const providerParams = {
  // Context window large enough that hot/warm both get a real share of the
  // input budget. With the default tier proportions (hot 0.6, warm 0.25)
  // and a 1200-token overhead allowance, this gives ~5k tokens of hot
  // capacity and ~2k of warm — enough that the seeded transcript below
  // overflows hot and the warm summariser actually runs.
  context_window_tokens: 10_000,
  max_tokens: 1_000,
};

const modelInfo = { providerName: "mock", modelId: "test-model" };

// summarizeTranscript drains the chat stream into a string. Returning a
// single chunk is enough to produce a non-empty summary.
function chatReturns(text: string) {
  chatSpy.mockImplementation(async () => {
    async function* gen() { yield text; }
    return { stream: gen() };
  });
}

function chatHangs() {
  chatSpy.mockImplementation(async () => {
    async function* gen() {
      // Never yields. raceWithBudget(100ms) must unwedge the caller.
      await new Promise<void>(() => { /* pending forever */ });
      yield "unreachable";
    }
    return { stream: gen() };
  });
}

function seedWarmThread(): string {
  const t = createThread("test-agent", "warm-cache");
  // ~4000 chars per message ≈ 1000 tokens. 8 messages ≈ 8k tokens, which
  // comfortably overflows the ~5k hot cap above so several messages spill
  // into the warm tier and the summariser engages.
  const long = "x ".repeat(2000);
  for (let i = 0; i < 8; i++) {
    addMessage(t.thread_id, i % 2 === 0 ? "user" : "assistant", `msg ${i} ${long}`);
  }
  return t.thread_id;
}

describe("buildHistoryWindow warm-summary cache", () => {
  beforeEach(() => {
    chatSpy.mockReset();
    recallSpy.mockReset();
    recallSpy.mockImplementation(async () => []);
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("caches the warm summary across turns when no explicit pin is set", async () => {
    const thread_id = seedWarmThread();
    chatReturns("RECAP-A");

    const first = await buildHistoryWindow(thread_id, agentCfg(), providerParams, "next question", modelInfo);
    expect(first.warmSummaryCtx).toContain("RECAP-A");
    expect(chatSpy).toHaveBeenCalledTimes(1);

    const persisted = getThread(thread_id);
    expect(persisted?.warm_summary).toContain("RECAP-A");
    // Stamped with the auto-boundary key (first hot message's timestamp),
    // not null — that's what lets the next turn hit the cache.
    expect(typeof persisted?.warm_summary_before).toBe("string");
    expect((persisted?.warm_summary_before ?? "").length).toBeGreaterThan(0);

    // Second turn with no thread mutations: same hot/warm split → cache hit,
    // chat NOT invoked a second time.
    chatSpy.mockClear();
    const second = await buildHistoryWindow(thread_id, agentCfg(), providerParams, "follow up", modelInfo);
    expect(second.warmSummaryCtx).toContain("RECAP-A");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("re-summarises when the explicit pin moves", async () => {
    const thread_id = seedWarmThread();
    chatReturns("RECAP-PIN-1");
    setThreadContextPin(thread_id, "2026-06-17T00:00:00.000Z");
    await buildHistoryWindow(thread_id, agentCfg(), providerParams, "q", modelInfo, "2026-06-17T00:00:00.000Z");
    expect(chatSpy).toHaveBeenCalledTimes(1);

    chatSpy.mockClear();
    chatReturns("RECAP-PIN-2");
    // Same pin → cache hit.
    await buildHistoryWindow(thread_id, agentCfg(), providerParams, "q2", modelInfo, "2026-06-17T00:00:00.000Z");
    expect(chatSpy).not.toHaveBeenCalled();

    // Move the pin → cache miss, summariser runs again.
    chatSpy.mockClear();
    await buildHistoryWindow(thread_id, agentCfg(), providerParams, "q3", modelInfo, "2026-06-17T06:00:00.000Z");
    expect(chatSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to empty warm summary when the summariser hangs past the budget", async () => {
    const thread_id = seedWarmThread();
    chatHangs();

    const start = Date.now();
    const result = await buildHistoryWindow(thread_id, agentCfg(), providerParams, "q", modelInfo);
    const elapsed = Date.now() - start;

    expect(result.warmSummaryCtx).toBe("");
    // 100ms budget + small overhead — should be well under 2s.
    expect(elapsed).toBeLessThan(2000);
    // Hung summariser must not poison the cache.
    expect(getThread(thread_id)?.warm_summary).toBeFalsy();
  });

  it("falls back to empty facts context when recall hangs past the budget", async () => {
    const thread_id = seedWarmThread();
    // Make the warm tier cheap so the warm budget isn't what we're timing.
    chatReturns("RECAP");
    // Recall never resolves — raceWithBudget(100ms) must unwedge it.
    recallSpy.mockImplementation(
      () => new Promise<unknown[]>(() => { /* pending forever */ }),
    );

    const start = Date.now();
    const result = await buildHistoryWindow(thread_id, agentCfg(), providerParams, "q", modelInfo);
    const elapsed = Date.now() - start;

    // No facts context surfaced when the embedding provider is unresponsive.
    expect(result.factsCtx).toBe("");
    // 100ms recall + 100ms warm summary budgets, with margin.
    expect(elapsed).toBeLessThan(2000);
  });
});
