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

const { addMessage, createThread, deleteThread, getThread, listThreads, setThreadContextPin, setThreadWarmSummary } =
  await import("@/lib/stores/threads");
const { buildHistoryWindow } = await import("./history-window");
const { refreshWarmSummary } = await import("../warm-summary-background");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { upsertModelConfig } = await import("@/lib/stores/model-config");
const { createAutomationActivity, finalizeAutomationActivity } =
  await import("@/lib/stores/automation-activity");
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

describe("history source isolation", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("keeps foreground and bridge history in separate scopes", async () => {
    const thread = createThread("scope-agent");
    addMessage(thread.thread_id, "user", "foreground question");
    addMessage(thread.thread_id, "assistant", "foreground answer");
    addMessage(thread.thread_id, "user", "scheduled prompt", null, "scheduled_task");
    addMessage(thread.thread_id, "assistant", "scheduled result", null, "scheduled_task");
    const bridgeMetadata = {
      bridge_conversation: {
        key: "bridge-1:chat-1",
        bridge_id: "bridge-1",
        chat_id: "chat-1",
      },
    };
    addMessage(thread.thread_id, "user", "bridge inbound", null, "bridge", bridgeMetadata);
    addMessage(thread.thread_id, "assistant", "bridge reply", null, "bridge", bridgeMetadata);
    addMessage(thread.thread_id, "user", "other bridge chat", null, "bridge", {
      bridge_conversation: {
        key: "bridge-1:chat-2",
        bridge_id: "bridge-1",
        chat_id: "chat-2",
      },
    });

    const foreground = await buildHistoryWindow(
      thread.thread_id,
      agentCfg(),
      providerParams,
      "next",
      modelInfo,
      null,
      { scope: "foreground", includeWarm: false },
    );
    const bridge = await buildHistoryWindow(
      thread.thread_id,
      agentCfg(),
      providerParams,
      "next",
      modelInfo,
      null,
      { scope: "bridge", includeWarm: false, bridgeKey: "bridge-1:chat-1" },
    );

    expect(foreground.history.map((message) => message.content)).toEqual([
      "foreground question",
      "foreground answer",
    ]);
    expect(bridge.history.map((message) => message.content)).toEqual([
      "bridge inbound",
      "bridge reply",
    ]);
  });

  it("adds only material background outcomes to foreground context", async () => {
    const thread = createThread("ledger-agent");
    addMessage(thread.thread_id, "user", "foreground question");
    const action = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "scheduled_task",
      sourceId: "task-action",
      label: "Mailbox cleanup",
    });
    finalizeAutomationActivity(action.msg_id, {
      disposition: "action",
      preview: "Archived 12 messages",
    });
    const noAction = createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "watcher",
      sourceId: "watcher-noop",
      label: "Release watcher",
    });
    finalizeAutomationActivity(noAction.msg_id, { disposition: "no_action" });

    const result = await buildHistoryWindow(
      thread.thread_id,
      agentCfg(),
      providerParams,
      "next",
      modelInfo,
      null,
      { scope: "foreground", includeWarm: false },
    );

    expect(result.backgroundActivityCtx).toContain("Mailbox cleanup");
    expect(result.backgroundActivityCtx).toContain("Archived 12 messages");
    expect(result.backgroundActivityCtx).not.toContain("Release watcher");
    expect(result.history.map((message) => message.content)).toEqual(["foreground question"]);
  });
});

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

  it("stores a foreground-scoped background summary without automation or bridge rows", async () => {
    upsertModelConfig(
      "background-summary-model",
      "mock",
      "test-model",
      { context_window_tokens: 10_000, max_tokens: 1_000 },
      true,
    );
    upsertAgentConfig({
      id: "background-summary-agent",
      name: "Background summary",
      identity: "",
      instructions: "",
      tools: [],
      model_config_name: "background-summary-model",
    });
    const thread = createThread("background-summary-agent");
    addMessage(thread.thread_id, "user", "foreground question with enough detail");
    addMessage(thread.thread_id, "assistant", "foreground answer with enough detail");
    addMessage(thread.thread_id, "user", "AUTOMATION_SECRET", null, "scheduled_task");
    addMessage(thread.thread_id, "assistant", "AUTOMATION_RESULT", null, "watcher");
    createAutomationActivity({
      threadId: thread.thread_id,
      sourceKind: "scheduled_task",
      sourceId: "background-summary-task",
      label: "AUTOMATION_LEDGER_SECRET",
    });
    const bridgeMetadata = {
      bridge_conversation: {
        key: "bridge-1:chat-1",
        bridge_id: "bridge-1",
        chat_id: "chat-1",
      },
    };
    addMessage(thread.thread_id, "user", "BRIDGE_SECRET", null, "bridge", bridgeMetadata);
    addMessage(thread.thread_id, "assistant", "BRIDGE_RESULT", null, "bridge", bridgeMetadata);
    const boundary = "2099-01-01T00:00:00.000Z";
    setThreadContextPin(thread.thread_id, boundary);
    chatReturns("BACKGROUND-RECAP");

    await refreshWarmSummary(thread.thread_id);

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const summaryRequest = JSON.stringify(chatSpy.mock.calls[0]);
    expect(summaryRequest).toContain("foreground question");
    expect(summaryRequest).toContain("foreground answer");
    expect(summaryRequest).not.toContain("AUTOMATION_");
    expect(summaryRequest).not.toContain("BRIDGE_");
    const persisted = getThread(thread.thread_id);
    expect(persisted?.warm_summary).toContain("<!-- jarela:warm-scope=foreground -->");
    expect(persisted?.warm_summary_before).toBe(boundary);
    expect(persisted?.warm_summary_source_messages).toBe(2);

    const result = await buildHistoryWindow(
      thread.thread_id,
      agentCfg(),
      providerParams,
      "follow up",
      modelInfo,
      boundary,
      { scope: "foreground" },
    );
    expect(result.warmSummaryCtx).toContain("BACKGROUND-RECAP");
    expect(chatSpy).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a foreground summary completed during a background refresh", async () => {
    upsertModelConfig(
      "background-race-model",
      "mock",
      "test-model",
      { context_window_tokens: 10_000, max_tokens: 1_000 },
      true,
    );
    upsertAgentConfig({
      id: "background-race-agent",
      name: "Background race",
      identity: "",
      instructions: "",
      tools: [],
      model_config_name: "background-race-model",
    });
    const thread = createThread("background-race-agent");
    addMessage(thread.thread_id, "user", "foreground question with enough detail");
    addMessage(thread.thread_id, "assistant", "foreground answer with enough detail");
    const boundary = "2099-01-01T00:00:00.000Z";
    setThreadContextPin(thread.thread_id, boundary);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    chatSpy.mockImplementation(async () => {
      async function* gen() {
        await gate;
        yield "STALE-BACKGROUND-RECAP";
      }
      return { stream: gen() };
    });

    const refresh = refreshWarmSummary(thread.thread_id);
    await vi.waitFor(() => expect(chatSpy).toHaveBeenCalledTimes(1));
    setThreadWarmSummary(
      thread.thread_id,
      "<!-- jarela:warm-scope=foreground -->\nFOREGROUND-WINS",
      boundary,
      2,
      64,
    );
    release();
    await refresh;

    expect(getThread(thread.thread_id)?.warm_summary).toBe(
      "<!-- jarela:warm-scope=foreground -->\nFOREGROUND-WINS",
    );
  });

  it("caps an over-large explicit context window to the known model limit", async () => {
    const thread_id = seedWarmThread();
    chatReturns("RECAP-CAPPED");

    const result = await buildHistoryWindow(
      thread_id,
      agentCfg(),
      { ...providerParams, context_window_tokens: 1_000_000 },
      "q",
      { providerName: "anthropic", modelId: "claude-sonnet-4-6" },
    );

    expect(result.budget.contextWindowTokens).toBe(200_000);
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

  it("clips an oversized latest hot message even when warm summary succeeds", async () => {
    const thread_id = seedWarmThread();
    addMessage(thread_id, "user", "latest " + "y ".repeat(20_000));
    chatReturns("RECAP-HUGE-HOT");

    const result = await buildHistoryWindow(thread_id, agentCfg(), providerParams, "q", modelInfo);

    expect(result.warmSummaryCtx).toContain("RECAP-HUGE-HOT");
    expect(result.tierUsage.hot_tokens).toBeLessThanOrEqual(result.budget.tierBudgets.hot);
    expect(String(result.history.at(-1)?.content)).toContain("[truncated for context budget]");
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
