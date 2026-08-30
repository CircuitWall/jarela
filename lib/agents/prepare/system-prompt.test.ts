import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-system-prompt-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { CACHE_SPLIT_SENTINEL, buildSystemPrompt, buildToolPermissionContext, buildToolReliabilityContext } = await import("./system-prompt");
const { recordToolUsage } = await import("@/lib/stores/tool-stats");
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

describe("buildSystemPrompt self-configuration", () => {
  it("tells agents to ask before creating skills for repeated workflows", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "repeat the release cleanup",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
    });

    expect(prompt).toContain("third or later instance of the same workflow");
    expect(prompt).toContain("ask whether the user wants you to create or update a skill");
    expect(prompt).toContain("Do not persist a newly synthesized skill without user consent");
  });
});

const permissionMapFixture = [
  {
    name: "file_read",
    description: "read files",
    source: "builtin",
    category: "Files",
    capability: "read",
    group: "Basic",
    credentials_required: [],
    status: "enabled",
    status_reason: null,
    permission: "enabled",
    permission_reason: "basic_default",
  },
  {
    name: "gmail_send_email",
    description: "send mail",
    source: "builtin",
    category: "Mail",
    capability: "write",
    group: null,
    credentials_required: [],
    status: "enabled",
    status_reason: null,
    permission: "disabled",
    permission_reason: "agent_not_allowed",
  },
  {
    name: "memory_read",
    description: "read memory",
    source: "builtin",
    category: "Memory",
    capability: "read",
    group: "Basic",
    credentials_required: [],
    status: "disabled",
    status_reason: "category_disabled",
    permission: "unavailable",
    permission_reason: "category_disabled",
  },
] satisfies import("@/lib/tools").ToolCatalogEntry[];

describe("buildToolPermissionContext", () => {
  it("renders the full deterministic tool permission list", () => {
    const ctx = buildToolPermissionContext([
      {
        ...permissionMapFixture[2],
      },
      permissionMapFixture[1],
      permissionMapFixture[0],
    ]);

    expect(ctx).toContain("--- Tool permission map ---");
    expect(ctx).toContain("You can execute 1 tool(s)");
    expect(ctx).toContain("This durable full tool list is intentionally placed in the cacheable system-prompt prefix.");
    expect(ctx).toContain("- Basic > Files > file_read: read/builtin/enabled reason=basic_default");
    expect(ctx).toContain("- Basic > Memory > memory_read: read/builtin/unavailable reason=category_disabled");
    expect(ctx).toContain("- Other > Mail > gmail_send_email: write/builtin/disabled reason=agent_not_allowed");
    expect(ctx).toContain("propose a permission/config change");
    expect(ctx.indexOf("file_read")).toBeLessThan(ctx.indexOf("gmail_send_email"));
  });

  it("places the full permission map before the cache split sentinel", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "dynamic recall",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      toolPermissionMap: permissionMapFixture,
    });

    expect(prompt.indexOf("--- Tool permission map ---")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("--- Tool permission map ---")).toBeLessThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    expect(prompt.indexOf("file_read: read/builtin/enabled")).toBeLessThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    expect(prompt.indexOf("dynamic recall")).toBeGreaterThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
  });
});

describe("buildToolReliabilityContext", () => {
  it("surfaces compact allowed-tool recovery hints from aggregate stats", () => {
    recordToolUsage([
      { id: "doc-a", phase: "call", name: "documents_search", payload: { query: "alpha" } },
      { id: "doc-a", phase: "result", name: "documents_search", payload: { error: "source missing" } },
      { id: "doc-b", phase: "call", name: "documents_search", payload: { query: "beta" } },
      { id: "doc-b", phase: "result", name: "documents_search", payload: { error: "source missing" } },
      { id: "doc-c", phase: "call", name: "documents_search", payload: { query: "gamma" } },
      { id: "doc-c", phase: "result", name: "documents_search", payload: { error: "source missing" } },
      { id: "file-a", phase: "call", name: "file_read", payload: { path: "README.md" } },
      { id: "file-a", phase: "result", name: "file_read", payload: { content: "Alpha success result" } },
      { id: "file-b", phase: "call", name: "file_read", payload: { path: "README.md" } },
      { id: "file-b", phase: "result", name: "file_read", payload: { content: "Beta success result" } },
      { id: "file-c", phase: "call", name: "file_read", payload: { path: "README.md" } },
      { id: "file-c", phase: "result", name: "file_read", payload: { content: "Gamma success result" } },
    ], "Alpha success result Beta success result Gamma success result");

    const ctx = buildToolReliabilityContext(["documents_search", "file_read"]);

    expect(ctx).toContain("--- Tool reliability hints ---");
    expect(ctx).toContain("file_read: historically reliable");
    expect(ctx).toContain("documents_search: check document sources/indexing");
    expect(ctx).toContain("documents_search: repeated not_found failures");
    expect(ctx).toContain("refresh ids/list sources first");
    expect(ctx).not.toContain("source missing");
    expect(ctx).not.toContain("README.md");
  });

  it("omits stats for tools that are not allowed in the current run", () => {
    const ctx = buildToolReliabilityContext(["file_read"]);

    expect(ctx).not.toContain("documents_search");
  });

  it("turns repeated timeout failure categories into split-work guidance", () => {
    recordToolUsage([
      { id: "large-a", phase: "call", name: "file_multi_edit", payload: { edits: "array" } },
      { id: "large-a", phase: "result", name: "file_multi_edit", payload: { error: "tool timeout after huge change" } },
      { id: "large-b", phase: "call", name: "file_multi_edit", payload: { edits: "array" } },
      { id: "large-b", phase: "result", name: "file_multi_edit", payload: { error: "deadline exceeded while applying huge change" } },
    ], "");

    const ctx = buildToolReliabilityContext(["file_multi_edit"]);

    expect(ctx).toContain("file_multi_edit: repeated timeout failures");
    expect(ctx).toContain("split large changes into smaller batches");
    expect(ctx).not.toContain("huge change");
  });
});
