import { describe, it, expect } from "vitest";
import { buildAdaptivePersonaContext } from "./adaptive-persona";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";

const baseAgent = (over: Partial<AgentConfigRow> = {}): AgentConfigRow => ({
  id: "a", name: "A", icon: "", identity: "", instructions: "", tools: "[]",
  model_config_name: "claude", is_default: 0, history_limit: 50, history_window_hours: 24,
  never_reply: 0,
  adaptive_persona_enabled: 1,
  adaptive_persona_strength: 100,
  adaptive_empathy: 50,
  adaptive_expressiveness: 50,
  adaptive_verbosity: 50,
  adaptive_mbti: "INTJ",
  voice_enabled: 0, voice_model: null, voice_name: null, voice_stt_model: null, voice_auto_speak: 0,
  created_at: "", updated_at: "",
  ...over,
} as unknown as AgentConfigRow);

describe("buildAdaptivePersonaContext", () => {
  it("returns empty string when adaptive persona is disabled", () => {
    const out = buildAdaptivePersonaContext(
      baseAgent({ adaptive_persona_enabled: 0 } as unknown as Partial<AgentConfigRow>),
      "anything",
    );
    expect(out).toBe("");
  });

  it("emits a header and the configured MBTI label", () => {
    const out = buildAdaptivePersonaContext(baseAgent({ adaptive_mbti: "ENFP" }), "hi");
    expect(out).toContain("--- Adaptive persona ---");
    expect(out).toContain("Preset: ENFP (Campaigner)");
    expect(out).toContain("Behavior profile: exploratory, collaborative, flexible, evidence=balanced");
    expect(out).toContain("Operating contract:");
  });

  it("makes INTJ-style adaptation operational, not just tonal", () => {
    const out = buildAdaptivePersonaContext(baseAgent({ adaptive_mbti: "INTJ" }), "debug this failure");
    expect(out).toContain("Behavior profile: directive, independent, linear, evidence=high");
    expect(out).toContain("Give a clear recommendation early");
    expect(out).toContain("Stay self-directed");
    expect(out).toContain("Use ordered, stepwise structure");
    expect(out).toContain("Prefer concrete evidence");
  });

  it("falls back to INTJ when adaptive_mbti is unknown or missing", () => {
    const unknown = buildAdaptivePersonaContext(baseAgent({ adaptive_mbti: "ZZZZ" }), "hi");
    expect(unknown).toContain("Preset: INTJ");

    const missing = buildAdaptivePersonaContext(
      baseAgent({ adaptive_mbti: null } as unknown as Partial<AgentConfigRow>),
      "hi",
    );
    expect(missing).toContain("Preset: INTJ");
  });

  it("detects 'frustrated' mood and surfaces frustration directive", () => {
    const out = buildAdaptivePersonaContext(baseAgent(), "this is broken and doesn't work, frustrating");
    expect(out).toContain("Detected user signal: frustrated");
    expect(out).toContain("validate briefly and offer a clear recovery path");
    expect(out).toContain("Do not over-explain the mistake");
  });

  it("detects 'rushed' mood from urgency words", () => {
    const out = buildAdaptivePersonaContext(baseAgent(), "ASAP urgent please right now");
    expect(out).toContain("Detected user signal: rushed");
    expect(out).toContain("front-load the answer");
  });

  it("detects 'positive' mood from gratitude words", () => {
    const out = buildAdaptivePersonaContext(baseAgent(), "thanks awesome — perfect, love it");
    expect(out).toContain("Detected user signal: positive");
  });

  it("falls back to 'neutral' for plain text", () => {
    const out = buildAdaptivePersonaContext(baseAgent(), "What is the capital of France?");
    expect(out).toContain("Detected user signal: neutral");
    expect(out).toContain("keep behavior stable and task-focused");
  });

  it("clamps out-of-range percent inputs into [0,100]", () => {
    const out = buildAdaptivePersonaContext(
      baseAgent({ adaptive_empathy: 9999, adaptive_verbosity: -50, adaptive_expressiveness: NaN }),
      "neutral",
    );
    expect(out).toMatch(/Target empathy: 100\/100/);
    expect(out).toMatch(/Target verbosity: \d+\/100/);
    // NaN expressiveness should fall back to 50 before signal adjustment.
    expect(out).toMatch(/Target expressiveness: 50\/100/);
  });

  it("at strength=0 the output bands match the raw configured values", () => {
    const out = buildAdaptivePersonaContext(
      baseAgent({
        adaptive_persona_strength: 0,
        adaptive_empathy: 80,
        adaptive_expressiveness: 20,
        adaptive_verbosity: 50,
      }),
      "this is broken doesn't work asap urgent",
    );
    // No adjustment despite strong signal: 80/20/50 → high/reserved/balanced.
    expect(out).toMatch(/Target empathy: 80\/100 \(high\)/);
    expect(out).toMatch(/Target expressiveness: 20\/100 \(reserved\)/);
    expect(out).toMatch(/Target verbosity: 50\/100 \(balanced\)/);
    expect(out).not.toContain("noticeably shape organization");
  });

  it("high strength explicitly tells the model to let the profile shape the response", () => {
    const out = buildAdaptivePersonaContext(baseAgent({ adaptive_persona_strength: 95 }), "walk me through this");
    expect(out).toContain("Let this adaptive profile noticeably shape organization and phrasing");
  });
});
