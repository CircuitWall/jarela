/**
 * Assembles every prompt Jarela can send and checks it for completeness and
 * correctness. Reading the builders is not enough â€” the bugs found so far
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
const { listStaticPrompts, promptsAffectedBy, SYSTEM_PROMPT_SOURCE_PREFIXES } = await import("./prompt-registry");
const { getAllToolCatalogAsync, applyAgentPermissionsToCatalog } = await import("@/lib/tools");
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import { getUsageStrategyProfile } from "./usage-strategy";

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* held open */ }
});

const { agentCfg, budget, buildVariants } = await import("./prompt-variants");

const { recordToolUsage } = await import("@/lib/stores/tool-stats");
for (let i = 0; i < 3; i++) {
  recordToolUsage([
    { id: `lookup-${i}`, phase: "call", name: "list_tools", payload: { query: "example" } },
    { id: `lookup-${i}`, phase: "result", name: "list_tools", payload: { content: "Example tool catalog" } },
    { id: `invoke-${i}`, phase: "call", name: "invoke_tool", payload: { args_json: "invalid-example" } },
    { id: `invoke-${i}`, phase: "result", name: "invoke_tool", payload: { error: "schema validation failed: synthetic fixture" } },
  ], "Example tool catalog");
}
const variants = await buildVariants();
const staticPrompts = listStaticPrompts();

describe("usage profile audit fixtures", () => {
  it("renders editable profile defaults in a single persona chapter in both navigation modes", async () => {
    const { USAGE_PROFILES, USAGE_PROFILE_VALUES } = await import("./usage-profile");
    for (const profile of USAGE_PROFILE_VALUES) {
      for (const mode of ["essential", "full"]) {
        const variant = variants.find((entry) => entry.id === `usage-profile-${profile}${mode === "full" ? "-full" : ""}`);
        expect(variant, `${profile}/${mode}`).toBeDefined();
        expect(variant!.prompt).toContain(`User interface mode: ${mode}.`);
        expect(variant!.prompt).toContain(`Citation setting: ${USAGE_PROFILES[profile].citationStrictness}.`);
        expect(variant!.prompt.match(/^--- Persona ---$/gm)).toHaveLength(1);
        expect(variant!.prompt).not.toContain("--- Usage profile ---");
        expect(variant!.prompt).not.toContain("--- Adaptive persona ---");
        expect(variant!.prompt).not.toContain("MBTI");
        if (USAGE_PROFILES[profile].style) {
          expect(variant!.prompt).toContain(`Target warmth: ${USAGE_PROFILES[profile].style!.empathy}/100`);
        } else {
          expect(variant!.prompt).toContain("Style customization: off");
        }
      }
    }
  });

  it("invalidates assembled artifacts when persona defaults or combination fixtures change", () => {
    for (const path of ["lib/agents/usage-profile.ts", "lib/agents/prompt-variants.ts"]) {
      expect(promptsAffectedBy([path]).systemPrompt).toBe(true);
    }
  });
});

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
      ...staticPrompts.map((p) => `- \`static.${p.id}.txt\` â€” ${p.purpose}`),
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
  it("includes skill discovery and tool catalog changes in assembled prompt review", () => {
    for (const source of ["lib/skills/index.ts", "lib/skills/frontmatter.ts", "lib/tools/system/skills.ts"]) {
      expect(promptsAffectedBy([source]).systemPrompt).toBe(true);
    }
  });

  it("registers the personal briefing skill with a usable example and honest validation limits", async () => {
    const prompt = staticPrompts.find((entry) => entry.id === "skill.personal-briefing");
    expect(prompt?.source).toBe("lib/skills/builtins/personal-briefing/SKILL.md");
    const example = prompt?.text.match(/```json\s+([\s\S]*?)```/)?.[1];
    expect(example).toBeTruthy();
    const { validatePersonalBriefing } = await import("@/lib/tools/general/validate-personal-briefing");
    expect(validatePersonalBriefing(JSON.parse(example!)).ok).toBe(true);
    expect(prompt?.text).toContain("do not prove provenance or factual accuracy");
    const catalog = await getAllToolCatalogAsync();
    expect(catalog.some((entry) => entry.name === "validate_personal_briefing")).toBe(true);
  });

  it("registers every static system prompt in the codebase", () => {
    const registered = new Set(staticPrompts.map((p) => p.source));
    // Any module declaring a prompt constant must appear in the registry, or
    // the inventory silently goes stale and verification means nothing.
    const declaring = [
      "lib/agents/citation-checker.ts",
      "lib/agents/hallucination-classifier.ts",
      "lib/agents/conversation-summary.ts",
      "lib/agents/compaction-pipeline.ts",
      "lib/pricing/llm-extract.ts",
      "lib/tools/claude-delegate.ts",
      "lib/agents/prepare/system-prompt.ts",
      "lib/agents/harness/presets.ts",
      "lib/lifecycle/system-signals.ts",
      "lib/agents/retry-prompts.ts",
      "lib/agents/first-run-onboarding.ts",
    ];
    for (const source of declaring) {
      expect(registered, `${source} declares a prompt but is not in prompt-registry.ts`).toContain(source);
    }
  });

  it("uses source seq values, not timestamps, for conversation topic boundaries", () => {
    const prompt = staticPrompts.find((p) => p.id === "agent.conversation-summary")?.text ?? "";
    expect(prompt).toContain("start_seq");
    expect(prompt).toContain("end_seq");
    expect(prompt).toContain("timestamps only as display labels");
    expect(prompt).not.toContain("copy those exact timestamps");
  });

  it("gives every registered prompt a non-empty id, purpose and body", () => {
    for (const p of staticPrompts) {
      expect(p.id, `${p.source} prompt has no id`).toMatch(/^[a-z][a-z0-9.:_-]*$/);
      expect(p.purpose.length, `${p.id} has no purpose`).toBeGreaterThan(10);
      expect(p.text.trim().length, `${p.id} is empty`).toBeGreaterThan(0);
    }
  });

  it("requires correction retries to preserve the complete answer", () => {
    for (const id of ["agent.retry-fabrication", "agent.retry-citation"]) {
      const prompt = staticPrompts.find((entry) => entry.id === id)?.text ?? "";
      expect(prompt).toContain("complete corrected answer to the original user request");
      expect(prompt).toContain("Preserve all valid explanations, calculations, tables, and conclusions");
      expect(prompt).toContain("Do not return only a correction or a tool confirmation");
      expect(prompt).not.toContain("Do NOT restate");
    }
  });

  it("keeps first-run onboarding sequenced and consent-based", () => {
    const kickoff = staticPrompts.find((entry) => entry.id === "agent.first-run-onboarding")?.text ?? "";
    const instructions = staticPrompts.find((entry) => entry.id === "agent.first-run-instructions")?.text ?? "";
    expect(kickoff).toContain("I named you Nova.");
    expect(kickoff).toContain("brief, natural summary of what is ready for us");
    expect(kickoff).toContain("ask me one thoughtful question");
    expect(kickoff).toContain("My first goal is: Help me turn meeting notes into clear next steps.");
    expect(kickoff).not.toContain("update_agent_instruction");
    expect(kickoff).not.toContain("tool");
    expect(instructions).toContain("Never change saved instructions without my explicit approval.");
    expect(instructions).toContain("use update_agent_instruction to save the agreed draft");
    expect(instructions).toContain("Keep internal setup actions and tool details out of your replies.");
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
    expect(promptsAffectedBy(["lib/agents/conversation-summary.ts"]).staticPromptIds)
      .toContain("agent.conversation-summary");

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
  it("keeps the configured resource-strategy guidance in the dynamic suffix for every variant", () => {
    for (const { id, prompt, usageStrategy = "cost_saving" } of variants) {
      const dynamic = prompt.split(CACHE_SPLIT_SENTINEL)[1] ?? "";
      const stable = prompt.split(CACHE_SPLIT_SENTINEL)[0];
      const instruction = getUsageStrategyProfile(usageStrategy).promptInstruction;
      expect(dynamic, `${id}: strategy instruction missing`).toContain(instruction);
      expect(stable, `${id}: strategy instruction leaked into cached prefix`).not.toContain(instruction);
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

  it("shares the composition contract across all profile, persona, and transport fixtures", () => {
    const sharedBlocks = variants.map(({ prompt }) => prompt.split(CACHE_SHARED_SPLIT_SENTINEL)[0]);
    expect(new Set(sharedBlocks).size).toBe(1);
    expect(sharedBlocks[0]).toContain("--- Instruction composition ---");
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

  it("assembles bounded, advisory tool-history retrieval only in the dynamic suffix", () => {
    const populated = variants.filter(({ prompt }) => prompt.includes("--- Tool reliability hints ---"));
    expect(populated.length).toBeGreaterThan(0);
    for (const { id, prompt } of populated) {
      const [stable, dynamic] = prompt.split(CACHE_SPLIT_SENTINEL);
      expect(stable, id).not.toContain("--- Tool reliability hints ---");
      expect(dynamic, id).toContain("list_tools: historically reliable (3/3");
      expect(dynamic, id).toContain("invoke_tool: repeated validation failures");
      expect(dynamic, id).toContain("Current schemas and permissions take precedence");
      expect(prompt, id).not.toContain("invalid-example");
      expect(prompt, id).not.toContain("synthetic fixture");
      const hints = dynamic.split("--- Tool reliability hints ---")[1].split("\n\n")[0];
      expect(hints.length, id).toBeLessThan(3000);
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
  it("keeps model updates separate from runtime activation and requires verified, deduplicated issue filing", async () => {
    const extractor = staticPrompts.find((prompt) => prompt.id === "extract.model-updates");
    const scheduled = staticPrompts.find((prompt) => prompt.id === "scheduled.model-pricing-refresh");
    expect(extractor?.text).toContain("false requires an explicit statement of non-support");
    expect(extractor?.text).toContain("these are NOT model capabilities");
    expect(extractor?.text).toContain("verbatim");
    for (const field of ["changed_models", "changed_provider_features", "adoption_required", "first_observed"]) {
      expect(scheduled?.text).toContain(field);
    }
    expect(scheduled?.text).toContain("including closed issues");
    expect(scheduled?.text).toContain("only after creation succeeds");
    expect(scheduled?.text).toContain("approval is missing");
    expect(scheduled?.text).toContain("deadline_ms=900000");
    expect(scheduled?.text).toContain("do not start a duplicate refresh");
    const catalog = await getAllToolCatalogAsync();
    expect(catalog.some((tool) => tool.name === "refresh_model_pricing")).toBe(true);
  });
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
