import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-system-prompt-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { buildSystemPrompt } = await import("./system-prompt");
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ContextBudget } from "@/lib/agents/context-budget";

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* tmp held open */ }
});

function agentCfg(overrides: Partial<AgentConfigRow> = {}): AgentConfigRow {
  return {
    id: "test-agent",
    name: "Test",
    icon: null,
    identity: "You are a test agent.",
    instructions: "Be terse.",
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

const budget: ContextBudget = {
  contextWindowTokens: 8000,
  outputReserveTokens: 1000,
  inputBudgetTokens: 4000,
  overheadTokens: 1200,
  tierPriority: ["hot", "warm", "facts"],
  tierBudgets: { hot: 2400, warm: 1000, facts: 600 },
};

describe("buildSystemPrompt delivery channel", () => {
  it("includes a Delivery channel block when delivered through a bridge", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      deliveryChannel: { kind: "whatsapp", name: "Family group" },
    });

    expect(prompt).toContain("--- Delivery channel ---");
    expect(prompt).toContain("WhatsApp");
    expect(prompt).toContain("Family group");
    // The directive must reassure the agent it has access to the channel —
    // that's the whole point of this block.
    expect(prompt).toMatch(/DO have access to WhatsApp/);
  });

  it("falls back to the raw kind when no human label is mapped", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      deliveryChannel: { kind: "carrier-pigeon", name: null },
    });

    expect(prompt).toContain("--- Delivery channel ---");
    expect(prompt).toContain("carrier-pigeon");
  });

  it("omits the block entirely for direct chat (no delivery_channel set)", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
    });

    expect(prompt).not.toContain("Delivery channel");
  });

  it("omits the block when the kind is empty", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      deliveryChannel: { kind: "" },
    });

    expect(prompt).not.toContain("Delivery channel");
  });
});
