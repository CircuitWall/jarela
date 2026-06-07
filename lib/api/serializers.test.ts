import { describe, it, expect } from "vitest";
import {
  agentToResponse,
  bridgeToResponse,
  mcpServerToResponse,
  messageToResponse,
  messageUsageToResponse,
  parseMessageMetadataForResponse,
  parseToolEventsForResponse,
  resolveContextWindowTokens,
} from "./serializers";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { BridgeRow } from "@/lib/stores/bridges";
import type { McpServerRow } from "@/lib/stores/mcp-servers";
import type { MessageRow } from "@/lib/stores/threads";
import type { MessageUsageRow } from "@/lib/stores/message-usage";

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

  it("defaults citation_strictness to 'off' when column is unset", () => {
    expect(agentToResponse(baseRow).citation_strictness).toBe("off");
  });

  it("passes citation_strictness through verbatim for known enum values", () => {
    for (const v of ["off", "informational", "standard", "strict"] as const) {
      const out = agentToResponse({ ...baseRow, citation_strictness: v } as AgentConfigRow);
      expect(out.citation_strictness).toBe(v);
    }
  });

  it("falls back to 'off' for unknown citation_strictness values (forward-compat)", () => {
    const out = agentToResponse({ ...baseRow, citation_strictness: "weird" } as AgentConfigRow);
    expect(out.citation_strictness).toBe("off");
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

// --- threads GET serializer (ADR-0041 + per-tier columns) ---

function makeUsageRow(overrides: Partial<MessageUsageRow> = {}): MessageUsageRow {
  return {
    message_id: "m1",
    thread_id: "t1",
    agent_id: "a1",
    agent_name: "A",
    provider: "anthropic",
    model_id: "claude-sonnet-4",
    model_config_name: null,
    input_tokens: 1000,
    output_tokens: 200,
    input_rate_usd_per_mtok: 3,
    output_rate_usd_per_mtok: 15,
    cost_usd: 0.006,
    created_at: "2026-05-30T00:00:00Z",
    hot_tokens: 700,
    warm_tokens: 200,
    facts_tokens: 50,
    overhead_tokens: 50,
    hot_budget_tokens: 60_000,
    warm_budget_tokens: 20_000,
    facts_budget_tokens: 10_000,
    context_window_tokens: 100_000,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    msg_id: "m1",
    thread_id: "t1",
    role: "assistant",
    content: "hello",
    created_at: "2026-05-30T00:00:00Z",
    tool_events: null,
    category: null,
    metadata: null,
    ...overrides,
  };
}

describe("messageUsageToResponse", () => {
  it("returns null when no row exists (user turn or legacy assistant row)", () => {
    expect(messageUsageToResponse(null)).toBeNull();
    expect(messageUsageToResponse(undefined)).toBeNull();
  });

  it("projects only the fields the ContextUsageBar consumes", () => {
    const out = messageUsageToResponse(makeUsageRow())!;
    expect(out).toEqual({
      input_tokens: 1000,
      output_tokens: 200,
      hot_tokens: 700,
      warm_tokens: 200,
      facts_tokens: 50,
      overhead_tokens: 50,
      hot_budget_tokens: 60_000,
      warm_budget_tokens: 20_000,
      facts_budget_tokens: 10_000,
      context_window_tokens: 100_000,
      // Anthropic prompt-cache breakdown carries through. NULL by default
      // (legacy rows + non-Anthropic providers) — see PR #181 follow-up.
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
    // Cost + provenance fields stay server-side; the bar doesn't need them.
    expect(out).not.toHaveProperty("cost_usd");
    expect(out).not.toHaveProperty("provider");
    expect(out).not.toHaveProperty("agent_id");
  });

  it("surfaces Anthropic cache token breakdown when populated", () => {
    const out = messageUsageToResponse(makeUsageRow({
      cache_creation_input_tokens: 4_000,
      cache_read_input_tokens: 80_000,
    }))!;
    expect(out.cache_creation_input_tokens).toBe(4_000);
    expect(out.cache_read_input_tokens).toBe(80_000);
  });

  it("preserves NULL tier columns for legacy snapshots", () => {
    const out = messageUsageToResponse(makeUsageRow({
      hot_tokens: null, warm_tokens: null, facts_tokens: null, overhead_tokens: null,
      hot_budget_tokens: null, warm_budget_tokens: null, facts_budget_tokens: null,
      context_window_tokens: null,
    }))!;
    expect(out.hot_tokens).toBeNull();
    expect(out.context_window_tokens).toBeNull();
    // Provider-reported totals still pass through so the legacy single-bar
    // fallback in ContextUsageBar has something to render.
    expect(out.input_tokens).toBe(1000);
    expect(out.output_tokens).toBe(200);
  });

  it("passes through snapshot-only rows where the provider didn't report tokens", () => {
    // Regression for the bar-not-rendering bug: snapshot-only rows carry
    // input_tokens=0 + cost=0 but a full tier breakdown.
    const out = messageUsageToResponse(makeUsageRow({
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      input_rate_usd_per_mtok: null, output_rate_usd_per_mtok: null,
    }))!;
    expect(out.input_tokens).toBe(0);
    expect(out.output_tokens).toBe(0);
    expect(out.hot_tokens).toBe(700);
    expect(out.context_window_tokens).toBe(100_000);
  });
});

describe("parseToolEventsForResponse", () => {
  it("returns undefined for null/empty input", () => {
    expect(parseToolEventsForResponse(null)).toBeUndefined();
    expect(parseToolEventsForResponse(undefined)).toBeUndefined();
    expect(parseToolEventsForResponse("")).toBeUndefined();
  });

  it("parses a JSON array verbatim", () => {
    const events = [{ id: "1", phase: "call", name: "x", payload: { a: 1 } }];
    expect(parseToolEventsForResponse(JSON.stringify(events))).toEqual(events);
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseToolEventsForResponse("{not json")).toBeUndefined();
  });

  it("returns undefined for non-array JSON (object, number, string)", () => {
    expect(parseToolEventsForResponse('{"a":1}')).toBeUndefined();
    expect(parseToolEventsForResponse("42")).toBeUndefined();
    expect(parseToolEventsForResponse('"hi"')).toBeUndefined();
    expect(parseToolEventsForResponse("null")).toBeUndefined();
  });
});

describe("messageToResponse", () => {
  it("attaches usage when the snapshot map carries this message_id", () => {
    const usageById = new Map([["m1", makeUsageRow()]]);
    const out = messageToResponse(makeMessageRow(), usageById);
    expect(out.id).toBe("m1");
    expect(out.role).toBe("assistant");
    expect(out.usage?.hot_tokens).toBe(700);
    expect(out.usage?.context_window_tokens).toBe(100_000);
  });

  it("sets usage=null for messages with no snapshot (user turns)", () => {
    const out = messageToResponse(
      makeMessageRow({ msg_id: "u1", role: "user", content: "hi" }),
      new Map(),
    );
    expect(out.usage).toBeNull();
  });

  it("defaults category to null when undefined on the row", () => {
    const row = makeMessageRow();
    delete (row as { category?: string | null }).category;
    expect(messageToResponse(row, new Map()).category).toBeNull();
  });

  it("passes category through when present", () => {
    const out = messageToResponse(
      makeMessageRow({ category: "bridge" }),
      new Map(),
    );
    expect(out.category).toBe("bridge");
  });

  it("parses tool_events JSON arrays", () => {
    const events = [{ id: "1", phase: "call", name: "web_search", payload: {} }];
    const out = messageToResponse(
      makeMessageRow({ tool_events: JSON.stringify(events) }),
      new Map(),
    );
    expect(out.tool_events).toEqual(events);
  });

  it("collapses malformed tool_events to undefined (so the wire shape stays clean)", () => {
    const out = messageToResponse(
      makeMessageRow({ tool_events: "not json" }),
      new Map(),
    );
    expect(out.tool_events).toBeUndefined();
  });

  it("defaults metadata to null when row carries no metadata", () => {
    expect(messageToResponse(makeMessageRow(), new Map()).metadata).toBeNull();
  });

  it("parses a JSON-object metadata blob through verbatim", () => {
    const meta = { citations: { checker_model: "haiku", claims: [], unverified_links: [] } };
    const out = messageToResponse(
      makeMessageRow({ metadata: JSON.stringify(meta) }),
      new Map(),
    );
    expect(out.metadata).toEqual(meta);
  });

  it("collapses malformed metadata to null", () => {
    const out = messageToResponse(
      makeMessageRow({ metadata: "not json" }),
      new Map(),
    );
    expect(out.metadata).toBeNull();
  });
});

describe("parseMessageMetadataForResponse", () => {
  it("returns null for empty / null input", () => {
    expect(parseMessageMetadataForResponse(null)).toBeNull();
    expect(parseMessageMetadataForResponse(undefined)).toBeNull();
    expect(parseMessageMetadataForResponse("")).toBeNull();
  });

  it("returns null for non-object JSON (array, number, string, null)", () => {
    expect(parseMessageMetadataForResponse("[]")).toBeNull();
    expect(parseMessageMetadataForResponse("42")).toBeNull();
    expect(parseMessageMetadataForResponse('"hi"')).toBeNull();
    expect(parseMessageMetadataForResponse("null")).toBeNull();
  });

  it("returns the parsed object for a JSON object", () => {
    expect(parseMessageMetadataForResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for malformed JSON", () => {
    expect(parseMessageMetadataForResponse("{not json")).toBeNull();
  });
});

describe("resolveContextWindowTokens", () => {
  it("prefers a positive model-configured cap", () => {
    expect(resolveContextWindowTokens(200_000, 8_192)).toBe(200_000);
  });

  it("falls back to the default when the model has no cap configured", () => {
    expect(resolveContextWindowTokens(null, 8_192)).toBe(8_192);
    expect(resolveContextWindowTokens(undefined, 8_192)).toBe(8_192);
  });

  it("treats zero or negative configured caps as missing (defensive)", () => {
    expect(resolveContextWindowTokens(0, 8_192)).toBe(8_192);
    expect(resolveContextWindowTokens(-1, 8_192)).toBe(8_192);
  });
});


