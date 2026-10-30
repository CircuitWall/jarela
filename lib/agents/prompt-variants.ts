/**
 * Deterministic agent system prompt variants used to verify prompts
 * (prompt-registry.test.ts) and to snapshot the prompt surface for release
 * changesets (lib/lifecycle/surface-collect.ts). Callers must set
 * JARELA_DB_DIR to a scratch directory before importing this module.
 */
import { buildSystemPrompt } from "./prepare/system-prompt";
import { getUsageStrategyProfile, type UsageStrategy } from "./usage-strategy";
import { getAllToolCatalogAsync, applyAgentPermissionsToCatalog, markProxyOnlyTools } from "@/lib/tools";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ContextBudget } from "@/lib/agents/context-budget";
import { DEFAULT_PERSONA_STYLE, USAGE_PROFILES, USAGE_PROFILE_VALUES } from "./usage-profile";
export const budget: ContextBudget = {
  contextWindowTokens: 200000,
  outputReserveTokens: 8000,
  inputBudgetTokens: 120000,
  overheadTokens: 4000,
  tierPriority: ["hot", "warm", "facts"],
  tierBudgets: { hot: 60000, warm: 40000, facts: 20000 },
};

export function agentCfg(overrides: Partial<AgentConfigRow> = {}): AgentConfigRow {
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

export interface Variant {
  id: string;
  prompt: string;
  usageStrategy?: UsageStrategy;
  /** Counts derived from the permission map, to check the prompt's own arithmetic. */
  expected?: { bound: number; proxy: number; denied: number; unavailable: number };
}

async function prepareVariantFixtures() {
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
  const delegateCfg = agentCfg({ tools: '["delegate_to_agent"]', delegate_targets: '["fixture-reviewer","fixture-summarizer"]' });
  const delegatePermissions = applyAgentPermissionsToCatalog(catalog, delegateCfg);
  const delegateTools = delegatePermissions.filter((tool) => tool.permission === "enabled").map((tool) => tool.name);

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

  return {
    cfg, permitted, allBound, narrowBound, withCap,
    delegateCfg, delegatePermissions, delegateTools, base,
  };
}

function expectedFor(
  map: readonly { permission?: string; permission_reason?: string | null }[],
): NonNullable<Variant["expected"]> {
  const reachable = new Set(["proxy_only", "provider_tool_limit"]);
  return {
    bound: map.filter((t) => t.permission === "enabled").length,
    proxy: map.filter((t) => t.permission_reason && reachable.has(t.permission_reason)).length,
    denied: map.filter((t) =>
      t.permission === "disabled" && !(t.permission_reason && reachable.has(t.permission_reason))).length,
    unavailable: map.filter((t) => t.permission === "unavailable").length,
  };
}

export async function buildVariants(): Promise<Variant[]> {
  const {
    cfg, permitted, allBound, narrowBound, withCap,
    delegateCfg, delegatePermissions, delegateTools, base,
  } = await prepareVariantFixtures();
  return [
    ...USAGE_PROFILE_VALUES.flatMap((usage_profile) => {
      const profile = USAGE_PROFILES[usage_profile];
      const preset = profile.style ?? DEFAULT_PERSONA_STYLE;
      return (["essential", "full"] as const).map((experienceMode) => ({
        id: `usage-profile-${usage_profile}${experienceMode === "full" ? "-full" : ""}`,
        prompt: buildSystemPrompt({
          ...base,
          agentCfg: agentCfg({
            usage_profile,
            instructions: "",
            citation_strictness: profile.citationStrictness,
            adaptive_persona_enabled: profile.style ? 1 : 0,
            adaptive_persona_strength: preset.strength,
            adaptive_empathy: preset.empathy,
            adaptive_expressiveness: preset.expressiveness,
            adaptive_verbosity: preset.verbosity,
          }),
          experienceMode,
        }),
      }));
    }),
    {
      id: "home-detailed-strict-plain-text",
      usageStrategy: "high_reasoning",
      prompt: buildSystemPrompt({
        ...base,
        agentCfg: agentCfg({
          usage_profile: "home", instructions: "Explain the tradeoffs in detail.",
          adaptive_persona_enabled: 1,
          adaptive_verbosity: 100, citation_strictness: "strict",
        }),
        experienceMode: "full",
        usageStrategyInstruction: getUsageStrategyProfile("high_reasoning").promptInstruction,
        autoRecallEnabled: true,
        autoFactsEnabled: true,
        deliveryChannel: { kind: "whatsapp" },
      }),
    },
    {
      id: "dev-friendly-concise",
      usageStrategy: "fast",
      prompt: buildSystemPrompt({
        ...base,
        agentCfg: agentCfg({
          usage_profile: "dev", instructions: "Give a concise status summary.",
          adaptive_persona_enabled: 1,
          adaptive_empathy: 90, adaptive_expressiveness: 90,
          adaptive_verbosity: 0, citation_strictness: "standard",
        }),
        experienceMode: "essential",
        usageStrategyInstruction: getUsageStrategyProfile("fast").promptInstruction,
      }),
    },
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
    {
      id: "generated-delegate-catalog",
      prompt: buildSystemPrompt({
        ...base,
        agentCfg: delegateCfg,
        experienceMode: "full",
        allowedTools: delegateTools,
        toolPermissionMap: markProxyOnlyTools(delegatePermissions, delegateTools, delegateTools),
        delegateRosterLines: [
          JSON.stringify({ id: "fixture-reviewer", name: "Fixture reviewer", provenance: "model-generated, not verified", purpose: "Review synthetic summaries", call_when: ["A synthetic summary needs validation"], do_not_call_for: ["Unrelated changes"], inputs: "Summary and fixture", output: "Review findings", tools: [] }),
          JSON.stringify({ id: "fixture-summarizer", name: "Fixture summarizer", provenance: "legacy", specialization: "No current generated specialization" }),
        ],
      }),
      expected: expectedFor(delegatePermissions),
    },
  ];
}
