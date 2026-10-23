import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUsageStrategyProfile } from "@/lib/agents/usage-strategy";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-system-prompt-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { CACHE_SHARED_SPLIT_SENTINEL, CACHE_SPLIT_SENTINEL, buildSystemPrompt, buildToolPermissionContext, buildSharedToolCatalogContext, buildToolReliabilityContext, formatLocalDateTime } = await import("./system-prompt");
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
    // WhatsApp shows markdown links as raw text.
    expect(prompt).toContain("WhatsApp does not render markdown links: write any link as the bare URL, even where a cite_as value is given.");
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
    expect(prompt).not.toContain("does not render markdown links");
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

describe("buildSystemPrompt proactive memory saving", () => {
  const build = () => buildSystemPrompt({
    agentCfg: agentCfg(),
    trimmedMessage: "I prefer short answers",
    budget,
    recallCtx: "",
    warmSummaryCtx: "",
    factsCtx: "",
    experienceMode: "full",
    delegateRosterLines: [],
  });

  it("orders the save procedure as trigger, check, write, validate, cite", () => {
    const prompt = build();
    const steps = ["1. Trigger:", "2. Check:", "3. Write:", "4. Validate:", "5. Cite:"].map((s) => prompt.indexOf(s));
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(prompt).toContain("backstop, not your save step");
  });

  it("keeps the save procedure in the cached agent-stable block", () => {
    const prompt = build();
    const split = prompt.indexOf(CACHE_SPLIT_SENTINEL);
    expect(split).toBeGreaterThan(0);
    expect(prompt.indexOf("Proactive save procedure")).toBeLessThan(split);
  });

  it("only names memory tools that are registered", async () => {
    const memory = await import("@/lib/tools/general/memory");
    const registered = new Set(Object.values(memory)
      .filter((v): v is { name: string } => typeof v === "object" && v !== null && "name" in v)
      .map((t) => t.name));
    const block = build().split("--- Memory & recall ---")[1]?.split("\n---")[0] ?? "";
    const named = new Set(block.match(/\bmemory_[a-z]+\b/g) ?? []);
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) expect(registered).toContain(name);
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
  {
    name: "web_search",
    description: "search web",
    source: "builtin",
    category: "Web",
    capability: "read",
    group: "Basic",
    credentials_required: [],
    status: "enabled",
    status_reason: null,
    permission: "disabled",
    permission_reason: "provider_tool_limit",
  },
] satisfies import("@/lib/tools").ToolCatalogEntry[];

describe("buildToolPermissionContext", () => {
  it("renders only the enabled deterministic tool permission list", () => {
    const ctx = buildToolPermissionContext([
      {
        ...permissionMapFixture[2],
      },
      permissionMapFixture[1],
      permissionMapFixture[0],
      permissionMapFixture[3],
    ]);

    expect(ctx).toContain("--- Enabled tools ---");
    // web_search is provider-cap omitted: it counts as reachable through the
    // proxy, not as denied. Counting it in both places contradicts itself.
    expect(ctx).toContain("You can execute the 1 tool(s) listed below directly, plus 1 further permitted tool(s) through invoke_tool. 1 known tool(s) are not enabled for this agent; 1 known tool(s) are globally unavailable.");
    expect(ctx).toContain("This list is only what is bound this turn, not the full inventory");
    expect(ctx).toContain("Follow the Tool usage SOP above");
    expect(ctx).not.toContain("Cached full tool index:");
    expect(ctx).not.toContain("- Memory: memory_read");
    expect(ctx).not.toContain("- Web: web_search");
    expect(ctx).toContain("reason=provider_tool_limit. Reach them with invoke_tool per SOP step 5");
    expect(ctx).toContain("- Basic > Files > file_read: read/builtin/enabled reason=basic_default");
    expect(ctx).not.toContain("- Basic > Memory > memory_read");
    expect(ctx).not.toContain("- Other > Mail > gmail_send_email");
    expect(ctx).toContain("propose narrowing this agent's pinned tool list");

    // The procedure lives in the cached block; the per-turn block must not
    // restate it or the cache prefix stops being the stable part.
    expect(ctx).not.toContain("1. Bound first");
    expect(ctx).not.toContain("scope=\"enabled\" searches executable tools");
  });

  it("lists unbound permitted tool names without definitions, capped, and never lists bound tools", () => {
    const entry = (name: string, reason: "proxy_only" | null) => ({
      ...permissionMapFixture[0],
      name,
      permission: reason ? "disabled" as const : "enabled" as const,
      permission_reason: reason ?? "agent_allowed",
    });
    const unbound = Array.from({ length: 160 }, (_, i) => entry(`unbound_tool_${String(i).padStart(3, "0")}`, "proxy_only"));
    const ctx = buildToolPermissionContext([entry("bound_tool", null), ...unbound]);

    const line = ctx.split("\n").find((l) => l.startsWith("Permitted but unbound tool names"));
    expect(line).toBeDefined();
    expect(line).toContain("unbound_tool_000");
    expect(line).not.toContain("unbound_tool_159");
    expect(line).toContain("and 10 more");
    expect(line).not.toContain("bound_tool,");
    // The count sentence and the name list describe the same set.
    expect(ctx).toContain("plus 160 further permitted tool(s) through invoke_tool");
  });

  it("renders the tool usage SOP as an ordered, tool-free static block", () => {
    const ctx = buildSharedToolCatalogContext();

    expect(ctx).toContain("--- Tool usage SOP ---");
    expect(ctx).toContain("1. Bound first.");
    expect(ctx).toContain("2. Otherwise look it up.");
    expect(ctx).toContain("3. Named target.");
    expect(ctx).toContain("4. Read the schema.");
    expect(ctx).toContain("5. Invoke through the proxy.");
    expect(ctx).toContain("6. Read large results by reference.");
    expect(ctx).toContain("7. Verify before reporting.");
    expect(ctx).toContain("8. Stop and ask.");
    expect(ctx).toContain("10. Link the source.");
    // Every source-link field a tool or bridge prompt emits must be named,
    // or the model cannot tell which value links back to the item.
    for (const field of ["cite_as", "web_link", "html_link", "chat_link"]) {
      expect(ctx).toContain(field);
    }
    expect(ctx).toContain("never construct, guess, or edit one");
    expect(ctx).toContain("For substantial tasks with several dependent phases, likely cross-turn progress, or explicit verification, use workflow_progress");
    expect(ctx).toContain("every built-in Jarela workflow and every workflow you create or follow");
    expect(ctx).toContain("each step must state its input, expected output, and concrete validation criteria");
    expect(ctx).toContain("validate each output before passing it to a later step");
    expect(ctx).toContain("record observed validation_evidence before marking an item done");
    expect(ctx).toContain("send the complete current item list on each update");
    expect(ctx).toContain("keep secrets or private data out of checklist fields");
    expect(ctx).toContain("record observed validation_evidence before marking an item done");
    expect(ctx).toContain("read, write, execute, send, schedule, delete, propose");
    expect(ctx).toContain("performed, proposed, blocked, failed, not_performed");

    expect(ctx).toContain("names=[\"exact_name\"]");
    expect(ctx).toContain("scope=\"all\"");
    expect(ctx).toContain("include_schema=true");
    expect(ctx).toContain("args_json");
    expect(ctx).toContain("result_ref.name");
    expect(ctx).toContain("offset/limit");
    expect(ctx).toContain("permission_reason=\"proxy_only\"");
    expect(ctx).toContain("permission_reason=\"provider_tool_limit\"");

    // Every denial reason the permission layer can emit must be explained,
    // or the model cannot tell a permission decision from a setup gap.
    for (const reason of [
      "agent_not_allowed",
      "category_disabled",
      "dropin_tool_disabled",
      "credentials_missing",
      "integration_unconfigured",
    ]) {
      expect(ctx).toContain(reason);
    }

    // The inventory is no longer embedded; it is discovered through list_tools.
    expect(ctx).not.toContain("Cached full tool index:");
    expect(ctx).not.toContain("file_read");
    expect(ctx).not.toContain("memory_read");
    expect(ctx).not.toContain("gmail_send_email");
    expect(ctx).not.toContain("github_search_issues");
  });

  it("places per-turn tool permission state after the cache split sentinel", () => {
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

    expect(prompt.indexOf("--- Enabled tools ---")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("--- Enabled tools ---")).toBeGreaterThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    expect(prompt.indexOf("file_read: read/builtin/enabled")).toBeGreaterThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    expect(prompt).not.toContain("gmail_send_email: write/builtin/disabled");
    expect(prompt.indexOf("dynamic recall")).toBeGreaterThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
  });

  it("provides the UTC clock and runtime-local date in the dynamic prompt", () => {
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
    const dynamic = prompt.slice(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    expect(dynamic).toMatch(/Current time: .* \(UTC\)\. Use this when computing scheduled task timestamps\./);
    expect(dynamic).toMatch(/Current local date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT(?:[+-]\d{2}:\d{2})? \([^\)]+\)\. Use this for local calendar-date interpretation\./);
    expect(dynamic).toContain(`(${timeZone})`);
    expect(dynamic).toContain("For elapsed-time rules, compare modification timestamps with current UTC time; do not infer a 24-hour interval from calendar dates.");
  });

  it("formats local offsets with an ASCII sign on both sides of UTC", () => {
    const now = new Date("2026-01-15T03:04:05.000Z");
    expect(formatLocalDateTime(now, "America/New_York")).toBe("2026-01-14 22:04:05 GMT-05:00");
    expect(formatLocalDateTime(now, "Asia/Kolkata")).toBe("2026-01-15 08:34:05 GMT+05:30");
  });

  it("places usage-strategy instructions in the dynamic prompt suffix", () => {
    const instruction = getUsageStrategyProfile("cost_saving").promptInstruction;
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      usageStrategyInstruction: instruction,
    });

    expect(prompt.indexOf("--- Economical response style ---")).toBeGreaterThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    expect(prompt).toContain("Answer in the fewest words that fully satisfy the request.");
    expect(prompt).toContain("Lead with the result.");
    expect(prompt).toContain("Do not restate the request, narrate routine steps, or add unsolicited background.");
  });

  it("keeps manual recall guidance in the dynamic suffix when auto recall is disabled", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "where did we save the deployment notes?",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      autoRecallEnabled: false,
      autoFactsEnabled: false,
    });
    const dynamic = prompt.slice(prompt.indexOf(CACHE_SPLIT_SENTINEL));

    expect(dynamic).toContain("Automatic saved-fact and chat-history recall is off for this turn.");
    expect(dynamic).toContain("memory_search");
    expect(dynamic).toContain("documents_search");
    expect(prompt.indexOf("--- Automatic recall ---")).toBeGreaterThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
  });

  it("describes automatic retrieval when high-reasoning recall is enabled", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "where did we save the deployment notes?",
      budget,
      recallCtx: "recalled fact",
      warmSummaryCtx: "",
      factsCtx: "saved fact",
      experienceMode: "full",
      delegateRosterLines: [],
      autoRecallEnabled: true,
      autoFactsEnabled: true,
    });

    expect(prompt).toContain("Automatic semantic recall of saved facts and prior chat messages is enabled for this turn.");
  });

  it("keeps the cached prefix stable when provider-cap tool state changes", () => {
    const build = (toolPermissionMap: import("@/lib/tools").ToolCatalogEntry[]) => buildSystemPrompt({
      agentCfg: agentCfg(),
      trimmedMessage: "hi",
      budget,
      recallCtx: "dynamic recall",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      toolPermissionMap,
    });
    const first = build(permissionMapFixture);
    const second = build(permissionMapFixture.map((tool) =>
      tool.name === "file_read"
        ? { ...tool, permission: "disabled", permission_reason: "provider_tool_limit" }
        : tool,
    ));

    expect(first.slice(0, first.indexOf(CACHE_SPLIT_SENTINEL))).toBe(
      second.slice(0, second.indexOf(CACHE_SPLIT_SENTINEL)),
    );
    expect(first.slice(first.indexOf(CACHE_SPLIT_SENTINEL))).not.toBe(
      second.slice(second.indexOf(CACHE_SPLIT_SENTINEL)),
    );
  });

  it("keeps the shared cached block stable across agents", () => {
    const first = buildSystemPrompt({
      agentCfg: agentCfg({ id: "agent-a", identity: "You are agent A.", instructions: "Use short replies." }),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      toolPermissionMap: permissionMapFixture,
    });
    const second = buildSystemPrompt({
      agentCfg: agentCfg({ id: "agent-b", identity: "You are agent B.", instructions: "Use detailed replies." }),
      trimmedMessage: "hi",
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      toolPermissionMap: permissionMapFixture,
    });

    expect(first.slice(0, first.indexOf(CACHE_SHARED_SPLIT_SENTINEL))).toBe(
      second.slice(0, second.indexOf(CACHE_SHARED_SPLIT_SENTINEL)),
    );
    expect(first.slice(first.indexOf(CACHE_SHARED_SPLIT_SENTINEL), first.indexOf(CACHE_SPLIT_SENTINEL))).not.toBe(
      second.slice(second.indexOf(CACHE_SHARED_SPLIT_SENTINEL), second.indexOf(CACHE_SPLIT_SENTINEL)),
    );
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
