import { describe, it, expect } from "vitest";
import { buildPersonaContext } from "./adaptive-persona";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { MBTI_TYPES } from "./adaptive-persona-presets";
import { USAGE_PROFILE_VALUES } from "./usage-profile";

function agentCfg(overrides: Partial<AgentConfigRow> = {}) {
  return {
    usage_profile: "custom" as const,
    adaptive_persona_enabled: 0, adaptive_persona_strength: 0,
    adaptive_empathy: 50, adaptive_expressiveness: 50, adaptive_verbosity: 50,
    adaptive_mbti: "INTJ",
    ...overrides,
  };
}

describe("buildPersonaContext", () => {
  it.each(USAGE_PROFILE_VALUES)("keeps %s organization when direct customization is disabled", (usage_profile) => {
    const out = buildPersonaContext(agentCfg({ usage_profile, adaptive_persona_enabled: 0 }), "urgent");
    expect(out.match(/^--- Persona ---$/gm)).toHaveLength(1);
    expect(out).toContain("Style customization: off");
    expect(out).not.toContain("Target warmth:");
    if (usage_profile === "home") expect(out).toContain("Lead with a short useful summary");
    if (usage_profile === "dev") expect(out).toContain("Ground every factual claim");
    if (usage_profile === "custom") expect(out).toContain("No preset response organization");
  });

  it("ignores every legacy MBTI value without losing direct style controls", () => {
    const settings = { usage_profile: "home", adaptive_persona_enabled: 1, adaptive_empathy: 80, adaptive_verbosity: 100 } as const;
    const expected = buildPersonaContext(agentCfg(settings), "hi");
    for (const adaptive_mbti of [...MBTI_TYPES, "ZZZZ", ""]) {
      expect(buildPersonaContext(agentCfg({ ...settings, adaptive_mbti }), "hi")).toBe(expected);
    }
    expect(expected).toContain("Target warmth: 80/100 (high)");
    expect(expected).toContain("Target verbosity: 100/100 (detailed)");
    expect(expected).toContain("Lead with a short useful summary");
    expect(expected).not.toMatch(/MBTI|Preset:|Behavior profile:|Operating contract:/);
  });

  it.each([
    ["this is broken and doesn't work, frustrating", "frustrated", "offer a clear recovery path"],
    ["ASAP urgent please right now", "rushed", "front-load the answer"],
    ["thanks awesome perfect, love it", "positive", "keep behavior stable and task-focused"],
    ["What is the capital of France?", "neutral", "keep behavior stable and task-focused"],
  ])("treats cues in %s as tentative rather than a personality diagnosis", (message, cue, directive) => {
    const out = buildPersonaContext(agentCfg({ adaptive_persona_enabled: 1, adaptive_persona_strength: 100 }), message);
    expect(out).toContain(`Possible conversational cue: ${cue}`);
    expect(out).toContain(directive);
    expect(out).toContain("keyword heuristics, not verified emotions");
  });

  it("clamps out-of-range and non-finite targets", () => {
    const out = buildPersonaContext(agentCfg({
      adaptive_persona_enabled: 1, adaptive_empathy: 9999,
      adaptive_verbosity: -50, adaptive_expressiveness: NaN,
    }), "neutral");
    expect(out).toContain("Target warmth: 100/100");
    expect(out).toContain("Target expressiveness: 50/100");
    expect(out).toContain("Target verbosity: 0/100");
    expect(out).not.toContain("NaN");
  });

  it("at strength zero keeps a steady style even with strong conversational cues", () => {
    const out = buildPersonaContext(agentCfg({
      adaptive_persona_enabled: 1, adaptive_persona_strength: 0,
      adaptive_empathy: 80, adaptive_expressiveness: 20, adaptive_verbosity: 50,
    }), "this is broken doesn't work asap urgent");
    expect(out).toContain("Target warmth: 80/100 (high)");
    expect(out).toContain("Target expressiveness: 20/100 (reserved)");
    expect(out).toContain("Target verbosity: 50/100 (balanced)");
    expect(out).toContain("Possible conversational cue: neutral");
    expect(out).not.toContain("Possible urgency cue");
    expect(out).not.toContain("Possible friction cue");
  });

  it("retains requested depth and evidence at every verbosity level", () => {
    for (const adaptive_verbosity of [0, 50, 100]) {
      const out = buildPersonaContext(agentCfg({
        usage_profile: "dev", adaptive_persona_enabled: 1, adaptive_verbosity,
      }), "status");
      expect(out).toContain("Explicit user requests for detail take precedence");
      expect(out).toContain("Verbosity targets are preferences, not minimum lengths");
      expect(out).toContain("Style never lowers grounding or citation requirements");
      expect(out).toContain("Ground every factual claim");
    }
  });
});
