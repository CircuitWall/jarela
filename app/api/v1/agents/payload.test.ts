import { describe, expect, it } from "vitest";
import { toCreateAgentInput, toUpdateAgentInput } from "./payload";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";

const baseRow: AgentConfigRow = {
  id: "agent-1",
  name: "Agent One",
  icon: null,
  identity: "identity",
  instructions: "instructions",
  tools: "[]",
  model_config_name: null,
  is_default: 0,
  history_limit: 50,
  history_window_hours: 8,
  never_reply: 0,
  adaptive_persona_enabled: 0,
  adaptive_persona_strength: 50,
  adaptive_empathy: 50,
  adaptive_expressiveness: 50,
  adaptive_verbosity: 50,
  adaptive_mbti: "INTJ",
  voice_enabled: 0,
  voice_model: "gemini-2.5-flash-preview-tts",
  voice_name: "Kore",
  voice_stt_model: "gemini-2.5-flash",
  voice_auto_speak: 1,
  harness_id: null,
  delegate_targets: null,
  context_tier_proportions: null,
  anti_hallucination_mode: null,
  anti_hallucination_model_config: null,
  citation_strictness: "off",
  display_filters: null,
  tool_credentials: null,
  router_policy: null,
  router_enabled: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("agent payload mapping", () => {
  it("passes router fields through on create", () => {
    const out = toCreateAgentInput("agent-1", {
      name: " Agent One ",
      router_policy: "balanced",
      router_enabled: false,
    });

    expect(out.name).toBe("Agent One");
    expect(out.router_policy).toBe("balanced");
    expect(out.router_enabled).toBe(false);
  });

  it("passes router fields through on update when provided", () => {
    const out = toUpdateAgentInput("agent-1", {
      router_policy: "quality",
      router_enabled: true,
    }, baseRow);

    expect(out.router_policy).toBe("quality");
    expect(out.router_enabled).toBe(true);
  });

  it("leaves router fields undefined on update when omitted", () => {
    const out = toUpdateAgentInput("agent-1", {}, baseRow);

    expect(out.router_policy).toBeUndefined();
    expect(out.router_enabled).toBeUndefined();
  });
});