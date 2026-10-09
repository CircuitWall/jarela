/**
 * Assembles every prompt Jarela can send and checks it for completeness and
 * correctness. Reading the builders is not enough — the bugs found so far
 * (contradictory tool counts, undocumented denial reasons) were only visible
 * in the assembled text.
 *
 * Set JARELA_PROMPT_DUMP=1 to also write the assembled prompts to .prompts/
 * for human review: `npm run prompts:dump`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-prompt-verify-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { buildSystemPrompt, CACHE_SHARED_SPLIT_SENTINEL, CACHE_SPLIT_SENTINEL } = await import("./prepare/system-prompt");
const { getUsageStrategyProfile } = await import("./usage-strategy");
const { listStaticPrompts, promptsAffectedBy, SYSTEM_PROMPT_SOURCE_PREFIXES } = await import("./prompt-registry");
const { getAllToolCatalogAsync, applyAgentPermissionsToCatalog, markProxyOnlyTools } = await import("@/lib/tools");
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ContextBudget } from "@/lib/agents/context-budget";

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* held open */ }
});

const budget: ContextBudget = {
  contextWindowTokens: 200000,
  outputReserveTokens: 8000,
  inputBudgetTokens: 120000,
  overheadTokens: 4000,
  tierPriority: ["hot", "warm", "facts"],
  tierBudgets: { hot: 60000, warm: 40000, facts: 20000 },
};

function agentCfg(overrides: Partial<AgentConfigRow> = {}): AgentConfigRow {
  return {
    id: "verify-agent",
    name: "Verify",
    icon: null,
    identity: "You are Jarela, a local assistant.",
    instructions: "Be terse.",
    tools: "[]",
    model_config_name: null,
    is_default: 1,
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

interface Variant {
  id: string;
  prompt: string;
  /** Counts derived from the permission map, to check the prompt's own arithmetic. */
  expected?: { bound: number; proxy: number; denied: number; unavailable: number };
}

async function buildVariants(): Promise<Variant[]> {
  const catalog = await getAllToolCatalogAsync();
  const pinned = ["gmail_search", "gmail_send_email"];
  const cfg = agentCfg({ tools: JSON.stringify(pinned) });
  const permissions = applyAgentPermissionsToCatalog(catalog, cfg);
  const permitted = permissions.filter((t) => t.permission === "enabled").map((t) => t.name);

  // Bind everything permitted: no proxy_only, the common case today.
  const allBound = markProxyOnlyTools(permissions, permitted, permitted);
  // Bind only the self-config tools so the rest becomes proxy_only.
  const narrowBound = permitted.filter((n) => n === "invoke_tool" || n === "list_tools");
  const withProxy = markProxyOnlyTools(permissions, narrowBound, permitted);
  // Simulate a provider cap displacing tools.
  const withCap = withProxy.map((t) =>
    t.name === "web_search"
      ? { ...t, permission: "disabled" as const, permission_reason: "provider_tool_limit" }
      : t);

  const base = {
    trimmedMessage: "check my unread mail",
    budget,
    recallCtx: "",
    warmSummaryCtx: "",
    factsCtx: "",
    delegateRosterLines: [],
    runtimeInstanceId: "verify-instance",
    usageStrategyInstruction: getUsageStrategyProfile("cost_saving").promptInstruction,
    systemSignals: [{
      seq: 1, id: "verify-signal", kind: "runtime.restart.completed" as const, schema_version: 1,
      operation_id: "verify-operation", agent_id: cfg.id, thread_id: "verify-thread",
      payload: '{"restarted":true,"protected_state_available":true}', created_at: 1,
    }],
  };

  const expectedFor = (map: readonly { permission?: string; permission_reason?: string | null }[]) => {
    const reachable = new Set(["proxy_only", "provider_tool_limit"]);
    return {
      bound: map.filter((t) => t.permission === "enabled").length,
      proxy: map.filter((t) => t.permission_reason && reachable.has(t.permission_reason)).length,
      denied: map.filter((t) =>
        t.permission === "disabled" && !(t.permission_reason && reachable.has(t.permission_reason))).length,
      unavailable: map.filter((t) => t.permission === "unavailable").length,
    };
  };

  return [
    {
      id: "minimal-agent",
      prompt: buildSystemPrompt({ ...base, agentCfg: agentCfg(), experienceMode: "essential" }),
    },
    {
      id: "pinned-tools-all-bound",
      prompt: buildSystemPrompt({
        ...base,
        agentCfg: cfg,
        experienceMode: "full",
        allowedTools: permitted,
        toolPermissionMap: allBound,
      }),
      expected: expectedFor(allBound),
    },
    {
      id: "proxy-only-and-provider-cap",
      prompt: buildSystemPrompt({
        ...base,
        agentCfg: cfg,
        experienceMode: "full",
        allowedTools: narrowBound,
        toolPermissionMap: withCap,
      }),
      expected: expectedFor(withCap),
    },
    {
      id: "delivery-channel",
      prompt: buildSystemPrompt({
        ...base,
        agentCfg: cfg,
        experienceMode: "full",
        deliveryChannel: { kind: "whatsapp" },
        allowedTools: permitted,
        toolPermissionMap: allBound,
      }),
      expected: expectedFor(allBound),
    },
  ];
}

const variants = await buildVariants();
const staticPrompts = listStaticPrompts();

if (process.env.JARELA_PROMPT_DUMP === "1") {
  const outDir = join(process.cwd(), ".prompts");
  mkdirSync(outDir, { recursive: true });
  for (const v of variants) writeFileSync(join(outDir, `system-prompt.${v.id}.txt`), v.prompt, "utf8");
  for (const p of staticPrompts) {
    writeFileSync(join(outDir, `static.${p.id}.txt`), `# ${p.source}\n# ${p.purpose}\n\n${p.text}`, "utf8");
  }
  // Lets scripts/dump-prompts.mjs map changed files to artifacts without
  // importing TypeScript.
  writeFileSync(
    join(outDir, "SOURCE_MAP.json"),
    JSON.stringify({
      systemPromptSourcePrefixes: SYSTEM_PROMPT_SOURCE_PREFIXES,
      systemPromptArtifacts: variants.map((v) => `system-prompt.${v.id}.txt`),
      staticPrompts: staticPrompts.map((p) => ({
        id: p.id,
        source: p.source,
        artifact: `static.${p.id}.txt`,
      })),
    }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(outDir, "INDEX.md"),
    [
      "# Assembled prompts",
      "",
      "Regenerate with `npm run prompts:dump`. Not committed.",
      "",
      "## Agent system prompt variants",
      ...variants.map((v) => `- \`system-prompt.${v.id}.txt\` (${v.prompt.length} chars)`),
      "",
      "## Static prompts",
      ...staticPrompts.map((p) => `- \`static.${p.id}.txt\` — ${p.purpose}`),
    ].join("\n"),
    "utf8",
  );
}

describe("runtime ownership", () => {
  it("explains every signal kind and permits reporting trusted historical receipts without repeating actions", async () => {
    const { systemSignalKindSchema } = await import("@/lib/stores/system-signals");
    for (const variant of variants) {
      for (const kind of systemSignalKindSchema.options) expect(variant.prompt, `${variant.id}: ${kind}`).toContain(kind);
      expect(variant.prompt).toContain("substantiate earlier named operations");
      expect(variant.prompt).toContain("not a new action this turn");
      expect(variant.prompt).toContain("signal_continuation_read_only");
    }
  });
  it("places targeted lifecycle signals after both cache boundaries", () => {
    for (const variant of variants) {
      const dynamic = variant.prompt.split(CACHE_SPLIT_SENTINEL)[1];
      expect(dynamic, variant.id).toContain("--- System signals ---");
      expect(dynamic, variant.id).toContain('"id":"verify-signal"');
      expect(variant.prompt.split(CACHE_SPLIT_SENTINEL)[0], variant.id).not.toContain("verify-signal");
      expect(dynamic, variant.id).toContain("not user requests or permission");
    }
  });

  it("does not expose process-local result references after a restart", () => {
    const prompt = buildSystemPrompt({
      agentCfg: agentCfg(), trimmedMessage: "continue", budget, recallCtx: "", warmSummaryCtx: "", factsCtx: "",
      experienceMode: "essential", delegateRosterLines: [], runtimeInstanceId: "new-instance",
      systemSignals: [{ seq: 1, id: "stale", kind: "background_tool.completed", schema_version: 1,
        operation_id: "old-operation", agent_id: "verify-agent", thread_id: "verify-thread", created_at: 1,
        payload: '{"result_instance":"old-instance","result_key":"stale-result-key","result_available":true}' }],
    });
    expect(prompt).toContain('"result_available":false');
    expect(prompt).not.toContain("stale-result-key");
  });

  it("keeps runtime tool descriptions consistent with restart approval", async () => {
    const catalog = await getAllToolCatalogAsync();
    const restart = catalog.find((entry) => entry.name === "restart_server");
    const setEnv = catalog.find((entry) => entry.name === "set_env_var");
    expect(restart?.description).toContain("interrupting your current turn and other active runs");
    expect(restart?.description).toContain("Only call this when the user explicitly approves that interruption");
    expect(setEnv?.description).toContain("requiresRestart=true result is not restart approval");
  });

  it("explains host ownership and restart approval in every shared prefix", () => {
    for (const variant of variants) {
      const sharedPrefix = variant.prompt.split(CACHE_SHARED_SPLIT_SENTINEL)[0];
      expect(sharedPrefix, variant.id).toContain("running inside the current Jarela server process");
      expect(sharedPrefix, variant.id).toContain("source repository or separate test instance");
      expect(sharedPrefix, variant.id).toContain("interrupts your own turn and other active runs");
      expect(sharedPrefix, variant.id).toContain("unless the user explicitly approves that interruption");
      expect(sharedPrefix, variant.id).toContain("requiresRestart=true indicates a pending change, not restart approval");
      expect(sharedPrefix, variant.id).toContain("Do not restart the host to recover from provider rate limits");
    }
  });
});

describe("prompt registry coverage", () => {
  it("registers every static system prompt in the codebase", () => {
    const registered = new Set(staticPrompts.map((p) => p.source));
    // Any module declaring a prompt constant must appear in the registry, or
    // the inventory silently goes stale and verification means nothing.
    const declaring = [
      "lib/agents/citation-checker.ts",
      "lib/agents/hallucination-classifier.ts",
      "lib/pricing/llm-extract.ts",
      "lib/tools/claude-delegate.ts",
      "lib/agents/prepare/system-prompt.ts",
      "lib/agents/harness/presets.ts",
      "lib/lifecycle/system-signals.ts",
    ];
    for (const source of declaring) {
      expect(registered, `${source} declares a prompt but is not in prompt-registry.ts`).toContain(source);
    }
  });

  it("gives every registered prompt a non-empty id, purpose and body", () => {
    for (const p of staticPrompts) {
      expect(p.id, `${p.source} prompt has no id`).toMatch(/^[a-z][a-z0-9.:_-]*$/);
      expect(p.purpose.length, `${p.id} has no purpose`).toBeGreaterThan(10);
      expect(p.text.trim().length, `${p.id} is empty`).toBeGreaterThan(0);
    }
  });

  it("keeps prompt ids unique", () => {
    const ids = staticPrompts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps a changed file back to the prompts it affects", () => {
    // Editing any system-prompt builder changes every variant.
    expect(promptsAffectedBy(["lib/agents/prepare/system-prompt.ts"]).systemPrompt).toBe(true);
    expect(promptsAffectedBy(["lib/agents/harness/presets.ts"]).systemPrompt).toBe(true);
    expect(promptsAffectedBy(["lib/agents/usage-strategy.ts"]).systemPrompt).toBe(true);
    expect(promptsAffectedBy(["lib/tools/index.ts"]).systemPrompt).toBe(false);

    // A standalone prompt only affects its own artifact.
    const citation = promptsAffectedBy(["lib/agents/citation-checker.ts"]);
    expect(citation.staticPromptIds).toContain("audit.citation-checker");
    expect(citation.staticPromptIds).not.toContain("pricing.llm-extract");

    // Windows paths must resolve too, or the narrowing silently returns nothing.
    expect(promptsAffectedBy(["lib\\agents\\prepare\\system-prompt.ts"]).systemPrompt).toBe(true);
  });

  it("declares every system-prompt source prefix as a real path", () => {
    for (const prefix of SYSTEM_PROMPT_SOURCE_PREFIXES) {
      expect(prefix.startsWith("lib/"), `${prefix} must be repo-relative`).toBe(true);
    }
  });
});

describe("assembled agent system prompt", () => {
  it("keeps cost-saving response guidance in the dynamic suffix for every variant", () => {
    for (const { id, prompt } of variants) {
      const dynamic = prompt.split(CACHE_SPLIT_SENTINEL)[1] ?? "";
      const stable = prompt.split(CACHE_SPLIT_SENTINEL)[0];
      expect(dynamic, `${id}: concise response instruction missing`).toContain("Answer in the fewest words that fully satisfy the request.");
      expect(dynamic, `${id}: lead-with-result instruction missing`).toContain("Lead with the result.");
      expect(dynamic, `${id}: no-repetition instruction missing`).toContain("Do not restate the request, narrate routine steps, or add unsolicited background.");
      expect(stable, `${id}: strategy instruction leaked into cached prefix`).not.toContain("Economical response style");
    }
  });

  it("emits both cache sentinels exactly once, in order", () => {
    for (const { id, prompt } of variants) {
      const shared = prompt.split(CACHE_SHARED_SPLIT_SENTINEL).length - 1;
      const stable = prompt.split(CACHE_SPLIT_SENTINEL).length - 1;
      expect(shared, `${id}: shared sentinel count`).toBe(1);
      expect(stable, `${id}: stable sentinel count`).toBe(1);
      expect(
        prompt.indexOf(CACHE_SHARED_SPLIT_SENTINEL),
        `${id}: shared sentinel must precede the stable one`,
      ).toBeLessThan(prompt.indexOf(CACHE_SPLIT_SENTINEL));
    }
  });

  it("puts the tool usage SOP in the shared cached prefix", () => {
    for (const { id, prompt } of variants) {
      const sharedBlock = prompt.split(CACHE_SHARED_SPLIT_SENTINEL)[0];
      expect(sharedBlock, `${id}: SOP must be cacheable across agents`).toContain("--- Tool usage SOP ---");
      // Per-turn state in the shared block would break the cross-agent cache.
      expect(sharedBlock, `${id}: shared block leaked per-turn state`).not.toContain("--- Enabled tools ---");
      expect(sharedBlock, `${id}: shared block leaked the agent identity`).not.toContain("You are Jarela");
    }
  });

  it("keeps the action vocabulary and destructive-confirmation rules once in the shared SOP", () => {
    for (const { id, prompt } of variants) {
      const sharedBlock = prompt.split(CACHE_SHARED_SPLIT_SENTINEL)[0];
      expect(sharedBlock, id).toContain("Classify the request. Informational answers may be direct");
      expect(sharedBlock, id).toContain("Use only these operation labels when describing work");
      expect(sharedBlock, id).toContain("destructive requests also need the required confirmation");
      expect(prompt.split("Use only these operation labels").length - 1, id).toBe(1);
      expect(prompt, id).not.toContain("Classify each request before answering");
    }
  });

  it("keeps per-turn tool state after the stable sentinel", () => {
    for (const { id, prompt } of variants) {
      const dynamic = prompt.split(CACHE_SPLIT_SENTINEL)[1] ?? "";
      const stable = prompt.split(CACHE_SPLIT_SENTINEL)[0];
      if (prompt.includes("--- Enabled tools ---")) {
        expect(dynamic, `${id}: tool state must not sit in the cached block`).toContain("--- Enabled tools ---");
        expect(stable).not.toContain("--- Enabled tools ---");
      }
    }
  });

  it("never contradicts itself about which tools are reachable", () => {
    for (const { id, prompt, expected } of variants) {
      const listed = prompt.split("\n").filter((l) => /^- .+ > .+ > .+: /.test(l));

      // A bound tool is executable now; a reachable-only reason on one of
      // these lines would tell the model both things at once.
      const confused = listed.filter((l) => /proxy_only|provider_tool_limit/.test(l));
      expect(confused, `${id}: bound list carries a not-bound reason`).toEqual([]);

      if (!expected) continue;
      const counts = prompt.match(
        /You can execute the (\d+) tool\(s\) listed below directly, plus (\d+) further permitted tool\(s\) through invoke_tool\. (\d+) known tool\(s\) are not enabled for this agent; (\d+) known tool\(s\) are globally unavailable\./,
      );
      expect(counts, `${id}: tool count sentence missing or reworded`).toBeTruthy();
      const [, bound, proxy, denied, unavailable] = counts!.map(Number) as unknown as number[];

      expect(listed.length, `${id}: rendered list length must equal the bound count`).toBe(bound);
      expect(bound, `${id}: bound count`).toBe(expected.bound);
      expect(proxy, `${id}: proxy-reachable count`).toBe(expected.proxy);
      // The bug this guards: proxy-reachable tools were also counted denied.
      expect(denied, `${id}: denied count must exclude proxy-reachable tools`).toBe(expected.denied);
      expect(unavailable, `${id}: unavailable count`).toBe(expected.unavailable);
    }
  });

  it("explains every denial reason the permission layer can emit", () => {
    // A reason the model cannot interpret becomes a silent dead end.
    const reasons = [
      "agent_not_allowed",
      "category_disabled",
      "dropin_tool_disabled",
      "credentials_missing",
      "integration_unconfigured",
      "proxy_only",
      "provider_tool_limit",
    ];
    for (const { id, prompt } of variants) {
      for (const reason of reasons) {
        expect(prompt, `${id}: prompt never explains ${reason}`).toContain(reason);
      }
    }
  });

  it("explains oversized tool result references", () => {
    for (const { id, prompt } of variants) {
      expect(prompt, `${id}: prompt never explains truncated tool results`).toContain("truncated=true");
      expect(prompt, `${id}: prompt never explains result_ref`).toContain("result_ref");
      expect(prompt, `${id}: prompt never names the retrieval tool`).toContain("tool_result_get");
      expect(prompt, `${id}: prompt never explains ranged reads`).toContain("offset/limit");
    }
  });

  it("names only tools that actually exist", async () => {
    const known = new Set((await getAllToolCatalogAsync()).map((t) => t.name));
    // Tool names the prompt tells the model to call, outside the bound list.
    const referenced = ["list_tools", "invoke_tool", "read_skill", "memory_write", "schedule_task", "workflow_progress"];
    for (const name of referenced) {
      expect(known, `prompt references ${name} but no such tool is registered`).toContain(name);
    }
  });

  it("leaves no unresolved template placeholders or undefined values", () => {
    for (const { id, prompt } of variants) {
      expect(prompt, `${id}: unrendered placeholder`).not.toMatch(/\{\{[^}]+\}\}/);
      expect(prompt, `${id}: leaked undefined`).not.toMatch(/\bundefined\b/);
      expect(prompt, `${id}: leaked NaN`).not.toContain("NaN");
      expect(prompt, `${id}: leaked [object Object]`).not.toContain("[object Object]");
    }
  });

  it("does not repeat a section header within one prompt", () => {
    for (const { id, prompt } of variants) {
      const headers = (prompt.match(/^--- .+ ---$/gm) ?? []);
      const seen = new Set<string>();
      for (const h of headers) {
        expect(seen.has(h), `${id}: duplicate section ${h}`).toBe(false);
        seen.add(h);
      }
    }
  });
});

describe("prompt cache prefixes", () => {
  // Provider prompt caching only pays off while the prefix is byte-identical.
  // A stray timestamp or per-turn value in a cached block silently turns every
  // turn into a full-price cache miss, which no other test would notice.
  const catalogPromise = getAllToolCatalogAsync();

  async function promptFor(agent: AgentConfigRow, message: string) {
    const permissions = applyAgentPermissionsToCatalog(await catalogPromise, agent);
    return buildSystemPrompt({
      agentCfg: agent,
      trimmedMessage: message,
      budget,
      recallCtx: "",
      warmSummaryCtx: "",
      factsCtx: "",
      experienceMode: "full",
      delegateRosterLines: [],
      toolPermissionMap: permissions,
      allowedTools: permissions.filter((t) => t.permission === "enabled").map((t) => t.name),
    });
  }

  const sharedOf = (p: string) => p.split(CACHE_SHARED_SPLIT_SENTINEL)[0];
  const stableOf = (p: string) => p.split(CACHE_SPLIT_SENTINEL)[0];

  it("keeps both cached blocks identical across turns of one agent", async () => {
    const agent = agentCfg({ id: "cache-agent" });
    const first = await promptFor(agent, "what is the weather");
    const second = await promptFor(agent, "now book me a flight");

    expect(sharedOf(second)).toBe(sharedOf(first));
    expect(stableOf(second)).toBe(stableOf(first));
  });

  it("keeps the shared block identical across different agents", async () => {
    const a = await promptFor(agentCfg({ id: "cache-a" }), "hello");
    const b = await promptFor(
      agentCfg({ id: "cache-b", identity: "You are Bee.", instructions: "Be verbose." }),
      "hello",
    );

    expect(sharedOf(b)).toBe(sharedOf(a));
  });

  it("keeps per-turn values out of the cached blocks", async () => {
    const prompt = await promptFor(agentCfg({ id: "cache-c" }), "hello");
    const cached = stableOf(prompt);

    expect(cached).not.toContain("Current time:");
    expect(cached).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("static prompts", () => {
  it("leaves no unresolved placeholders", () => {
    for (const p of staticPrompts) {
      expect(p.text, `${p.id}: unrendered placeholder`).not.toMatch(/\{\{[^}]+\}\}/);
      expect(p.text, `${p.id}: leaked undefined`).not.toMatch(/\bundefined\b/);
    }
  });

  it("states an output contract when it asks for structured output", () => {
    for (const p of staticPrompts) {
      // Only prompts that demand JSON *back* need to show the shape;
      // mentioning a tool's JSON output in passing does not.
      const demandsJson = /(reply|respond|return|output|emit|answer)[^.\n]{0,40}\bJSON\b/i.test(p.text);
      if (!demandsJson) continue;
      expect(
        /\{|\[/.test(p.text),
        `${p.id} asks the model to return JSON but never shows the expected shape`,
      ).toBe(true);
    }
  });
});

describe("skill and instruction files", () => {
  it("keeps repo skills discoverable with frontmatter", () => {
    const skillDir = join(process.cwd(), ".github", "skills");
    const skills = [
      "jarela-change-sop",
      "tool-telemetry-complaints",
      "contributor-info-safety",
      "prompt-verification",
    ];
    for (const name of skills) {
      const body = readFileSync(join(skillDir, name, "SKILL.md"), "utf8");
      expect(body.startsWith("---"), `${name}: missing frontmatter`).toBe(true);
      expect(body, `${name}: frontmatter needs a name`).toMatch(/^name:\s*\S+/m);
      expect(body, `${name}: frontmatter needs a description`).toMatch(/^description:\s*\S+/m);
    }
  });
});
