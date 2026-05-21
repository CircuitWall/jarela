import { describe, it, expect } from "vitest";
import { agentToResponse, bridgeToResponse, mcpServerToResponse } from "./serializers";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { BridgeRow } from "@/lib/stores/bridges";
import type { McpServerRow } from "@/lib/stores/mcp-servers";

describe("agentToResponse", () => {
  const baseRow: AgentConfigRow = {
    id: "alice",
    name: "Alice",
    icon: "🤖",
    identity: "id",
    instructions: "do things",
    tools: '["a","b"]',
    model_config_name: "claude",
    is_default: 1,
    history_limit: 50,
    history_window_hours: 24,
    never_reply: 0,
    adaptive_persona_enabled: 1,
    adaptive_persona_strength: 0.5,
    adaptive_empathy: 0.7,
    adaptive_expressiveness: 0.6,
    adaptive_verbosity: 0.4,
    adaptive_mbti: "INTJ",
    voice_enabled: 0,
    voice_model: null,
    voice_name: null,
    voice_stt_model: null,
    voice_auto_speak: 0,
    created_at: "2026-05-21T00:00:00Z",
    updated_at: "2026-05-21T00:00:00Z",
  } as unknown as AgentConfigRow;

  it("parses tools JSON into array", () => {
    expect(agentToResponse(baseRow).tools).toEqual(["a", "b"]);
  });

  it("falls back to [] for malformed tools JSON", () => {
    const out = agentToResponse({ ...baseRow, tools: "not json" } as AgentConfigRow);
    expect(out.tools).toEqual([]);
  });

  it("coerces SQLite 0/1 booleans to JS booleans", () => {
    const out = agentToResponse(baseRow);
    expect(out.is_default).toBe(true);
    expect(out.never_reply).toBe(false);
    expect(out.adaptive_persona_enabled).toBe(true);
    expect(out.voice_enabled).toBe(false);
    expect(out.voice_auto_speak).toBe(false);
  });

  it("preserves scalar fields verbatim", () => {
    const out = agentToResponse(baseRow);
    expect(out.id).toBe("alice");
    expect(out.history_limit).toBe(50);
    expect(out.created_at).toBe("2026-05-21T00:00:00Z");
  });
});

describe("bridgeToResponse", () => {
  const row: BridgeRow = {
    id: "b1",
    kind: "whatsapp",
    name: "Personal",
    status: "connected",
    last_error: null,
    paired_id: "55123",
    enabled: 1,
    created_at: "2026-05-21T00:00:00Z",
    updated_at: "2026-05-21T00:00:00Z",
  } as unknown as BridgeRow;

  it("converts enabled 1 → true", () => {
    expect(bridgeToResponse(row).enabled).toBe(true);
  });

  it("converts enabled 0 → false", () => {
    expect(bridgeToResponse({ ...row, enabled: 0 } as BridgeRow).enabled).toBe(false);
  });

  it("preserves the rest of the fields verbatim", () => {
    const out = bridgeToResponse(row);
    expect(out.id).toBe("b1");
    expect(out.kind).toBe("whatsapp");
    expect(out.status).toBe("connected");
    expect(out.paired_id).toBe("55123");
  });
});

describe("mcpServerToResponse", () => {
  const row: McpServerRow = {
    name: "github",
    transport: "stdio",
    spec: '{"command":"npx","args":["mcp-github"]}',
    enabled: 1,
    last_error: null,
    created_at: "2026-05-21T00:00:00Z",
    updated_at: "2026-05-21T00:00:00Z",
  } as unknown as McpServerRow;

  it("parses spec JSON", () => {
    const out = mcpServerToResponse(row);
    expect(out.spec).toEqual({ command: "npx", args: ["mcp-github"] });
  });

  it("falls back to null for malformed spec JSON", () => {
    const out = mcpServerToResponse({ ...row, spec: "not json" } as McpServerRow);
    expect(out.spec).toBeNull();
  });

  it("converts enabled to boolean", () => {
    expect(mcpServerToResponse(row).enabled).toBe(true);
    expect(mcpServerToResponse({ ...row, enabled: 0 } as McpServerRow).enabled).toBe(false);
  });
});
