import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-memory-contract-"));
process.env.JARELA_DB_DIR = tmpRoot;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* SQLite may hold the file */ }
});

await import("@/lib/tools/runtime/builtins");
const { MEMORY_CONFIDENCE, MEMORY_KINDS, MEMORY_SOURCES, MEMORY_STATUSES } = await import("./record");
const {
  MEMORY_CONTRACT_VERSION, MEMORY_FACTS_NAMESPACE, MEMORY_KEY_RULE, memoryContractSummary,
} = await import("./contract");
const { registeredCapability } = await import("@/lib/tools/runtime/registry");
const { buildSystemPrompt } = await import("@/lib/agents/prepare/system-prompt");
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ContextBudget } from "@/lib/agents/context-budget";

const skill = readFileSync(
  join(process.cwd(), "lib", "skills", "builtins", "memory-organization", "SKILL.md"), "utf8",
);

const budget: ContextBudget = {
  contextWindowTokens: 8000,
  outputReserveTokens: 1000,
  inputBudgetTokens: 4000,
  overheadTokens: 1200,
  tierPriority: ["hot", "warm", "facts"],
  tierBudgets: { hot: 2400, warm: 1000, facts: 600 },
};

function promptFor(): string {
  const agentCfg = {
    id: "contract-agent", name: "Contract", icon: null, identity: "", instructions: "", tools: "[]",
    model_config_name: null, is_default: 0, history_limit: 50, history_window_hours: 8, never_reply: 0,
    adaptive_persona_enabled: 0, adaptive_persona_strength: 0, adaptive_empathy: 50,
    adaptive_expressiveness: 50, adaptive_verbosity: 50, adaptive_mbti: "INTJ", voice_enabled: 0,
    voice_model: "", voice_name: "", voice_stt_model: "", voice_auto_speak: 0, display_filters: null,
    harness_id: null, delegate_targets: null, context_tier_proportions: null,
    anti_hallucination_mode: null,
  } as unknown as AgentConfigRow;
  return buildSystemPrompt({
    agentCfg, trimmedMessage: "clean up my saved memory", budget,
    recallCtx: "", warmSummaryCtx: "", factsCtx: "", experienceMode: "full",
    delegateRosterLines: [],
  });
}

describe("memory contract conformance", () => {
  it("keeps the skill's enumerated values identical to the record schema", () => {
    for (const value of [...MEMORY_KINDS, ...MEMORY_CONFIDENCE, ...MEMORY_SOURCES, ...MEMORY_STATUSES]) {
      expect(skill, `SKILL.md must document the '${value}' value`).toContain(value);
    }
  });

  it("states the canonical namespace and key rule in the skill, the prompt and the contract summary", () => {
    const prompt = promptFor();
    for (const text of [skill, prompt, memoryContractSummary()]) {
      expect(text).toContain(MEMORY_FACTS_NAMESPACE);
      expect(text).toContain(MEMORY_KEY_RULE);
    }
    expect(skill).toContain(`Memory contract v${MEMORY_CONTRACT_VERSION}`);
    expect(prompt).toContain("memory-organization");
  });

  it("names only registered maintenance tools", () => {
    expect(skill).toContain("memory_audit");
    expect(skill).toContain("memory_apply_maintenance");
    expect(registeredCapability("memory_audit")).toBe("read");
    expect(registeredCapability("memory_apply_maintenance")).toBe("write");
  });
});
