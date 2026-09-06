import type { ModelConfig } from "@/api/types";
import type { ContentPart } from "@/lib/tools/types";
import { modelCapabilities } from "@/lib/providers/capabilities";
import { detectModelFunctionality } from "@/lib/dashboard/classify";
import type { ProviderRates } from "@/lib/stores/pricing";
import { getKnownContextLength } from "@/lib/providers/known-context-windows";
import { computeContextBudget, type ContextTierProportions } from "@/lib/agents/context-budget";

export type ModelRouterPolicy = "cheap" | "fast" | "balanced" | "quality";
export type ModelRouteClass = "simple-chat" | "factual" | "research" | "complex-reasoning" | "multimodal";
export type ModelRouteSource = "pinned" | "agent_override" | "heuristic" | "default_fallback";

export interface LatestUsageHint {
  model_config_name: string | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

export interface RouteTurnModelOptions {
  models: readonly ModelConfig[];
  message: string;
  attachments?: readonly ContentPart[];
  hasImageContext?: boolean;
  allowedTools?: readonly string[];
  requiredHotContextTokens?: number | null;
  contextTierProportions?: ContextTierProportions | null;
  policy: ModelRouterPolicy;
  latestUsage?: LatestUsageHint | null;
  latestObservation?: RouteDecisionMetadata | null;
  rateResolver?: (provider: string, modelId: string) => Pick<ProviderRates, "inputPer1M" | "outputPer1M">;
}

export interface RouteTurnModelResult {
  modelConfigName: string | null;
  routeClass: ModelRouteClass;
  reason: string;
  candidates: string[];
}

export interface RouteDecisionMetadata {
  source: ModelRouteSource;
  model_config_name: string | null;
  route_class?: ModelRouteClass;
  policy?: ModelRouterPolicy;
  reason: string;
  candidates?: string[];
  duration_ms?: number;
  terminal?: "done" | "error";
  error_code?: string;
  retry_count?: number;
}

export interface RouteOutcome {
  durationMs: number;
  terminal: "done" | "error";
  errorCode?: string;
  retryCount?: number;
}

const RESEARCH_RE = /\b(research|investigate|compare|survey|sources?|citations?|evidence|find out|look up|search|browse|web|documentation|docs|read the file|analyze this file)\b/i;
const FACTUAL_RE = /\b(fact|factual|verify|accurate|accuracy|source|reference|references|cite|citation|proof|evidence)\b/i;
const COMPLEX_RE = /\b(why|root cause|trade-?off|strategy|design|architecture|plan|debug|diagnose|reason|step by step|deep dive|complex)\b/i;
const FAST_MODEL_RE = /\b(mini|nano|haiku|flash)\b/i;
const SLOW_MODEL_RE = /\b(opus|sonnet|max|pro|o1|o3|reasoner|gpt-5)\b/i;
const FILEY_TYPES = new Set(["file", "file_ref", "image_ref", "image"]);
const RESEARCH_TOOLS = new Set(["web_search", "fetch_webpage", "documents", "file_read", "memory_read"]);
// These model types don't accept chat/completion requests at all (e.g. an
// embeddings endpoint rejects a normal turn), so they must never enter the
// routing pool — not even as a last-resort fallback when no other candidate
// matches the turn's requirements.
const NON_GENERATIVE_FUNCTIONALITY = new Set(["embeddings", "reranking", "moderation"]);

export function routeTurnModel(options: RouteTurnModelOptions): RouteTurnModelResult {
  const observedClass = classifyTurn(options.message, options.attachments, options.allowedTools, options.hasImageContext);
  const previousClass = options.latestObservation?.route_class ?? null;
  const routeClass = applyClassRatchet(observedClass, previousClass, options.message);
  const held = routeClass !== observedClass;
  const routable = options.models.filter(
    (model) => !NON_GENERATIVE_FUNCTIONALITY.has(detectModelFunctionality(model.model_id)),
  );
  if (routable.length === 0) {
    return { modelConfigName: null, routeClass, reason: "no chat-capable model configs available", candidates: [] };
  }

  const filtered = filterCandidates(routable, routeClass, options.attachments, options.allowedTools, options.hasImageContext);
  const capabilityCandidates = filtered.length > 0 ? filtered : routable;
  const contextFit = filterByHotContextBudget(capabilityCandidates, options.requiredHotContextTokens, options.contextTierProportions);
  const candidates = contextFit.length > 0 ? contextFit : capabilityCandidates;
  const scored = candidates
    .map((model) => ({
      model,
      score: scoreCandidate(model, routeClass, options),
    }))
    .sort((a, b) => b.score - a.score || a.model.name.localeCompare(b.model.name));

  const winner = scored[0]?.model ?? null;
  const classLabel = held ? `${routeClass} (held from previous turn)` : routeClass;
  return {
    modelConfigName: winner?.name ?? null,
    routeClass,
    reason: winner
      ? `class=${classLabel}; policy=${options.policy}; chose ${winner.name} from ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${contextFit.length > 0 ? `; hot_context_tokens=${Math.floor(options.requiredHotContextTokens ?? 0)}` : ""}`
      : `class=${classLabel}; no viable model after routing`,
    candidates: candidates.map((model) => model.name),
  };
}

// How demanding each class is. `classifyTurn` reads only the current message,
// so a terse follow-up inside a research thread ("i want the exact dimension
// 1860x600") matches no keyword and lands in `simple-chat`.
const CLASS_RANK: Record<ModelRouteClass, number> = {
  "simple-chat": 0,
  factual: 1,
  "complex-reasoning": 2,
  research: 3,
  multimodal: 3,
};

// Below this, a message is treated as a follow-up rather than a fresh topic.
const FOLLOW_UP_MAX_CHARS = 200;

/**
 * Escalate immediately, de-escalate reluctantly.
 *
 * Switching models mid-conversation throws away the provider prompt cache for
 * the whole stable system-prompt prefix, so a downgrade has to earn itself. A
 * short follow-up is continuation of the work in flight, not a new simple
 * question, and keeps the class the conversation is already running at. A
 * long standalone message is allowed to downgrade — that is a real topic change.
 *
 * `multimodal` is never inherited: it is driven by the attachments and image
 * context of the turn itself, which `classifyTurn` already re-detects.
 */
export function applyClassRatchet(
  observed: ModelRouteClass,
  previous: ModelRouteClass | null | undefined,
  message: string,
): ModelRouteClass {
  if (!previous || previous === "multimodal" || observed === "multimodal") return observed;
  if (CLASS_RANK[observed] >= CLASS_RANK[previous]) return observed;
  return (message ?? "").trim().length <= FOLLOW_UP_MAX_CHARS ? previous : observed;
}

export function classifyTurn(
  message: string,
  attachments?: readonly ContentPart[],
  allowedTools?: readonly string[],
  hasImageContext?: boolean,
): ModelRouteClass {
  const text = (message ?? "").trim();
  const lowerTools = new Set((allowedTools ?? []).map((tool) => tool.toLowerCase()));
  const hasImage = hasImageContext || (attachments ?? []).some((part) => part.type === "image" || part.type === "image_ref");
  const hasFile = (attachments ?? []).some((part) => FILEY_TYPES.has(part.type));
  const hasResearchTool = Array.from(lowerTools).some((tool) => RESEARCH_TOOLS.has(tool));

  if (hasImage) return "multimodal";
  if ((hasFile && hasResearchTool) || RESEARCH_RE.test(text)) return "research";
  if (FACTUAL_RE.test(text)) return "factual";
  if (COMPLEX_RE.test(text) || text.length > 500) return "complex-reasoning";
  return "simple-chat";
}

function filterCandidates(
  models: readonly ModelConfig[],
  routeClass: ModelRouteClass,
  attachments?: readonly ContentPart[],
  allowedTools?: readonly string[],
  hasImageContext?: boolean,
): ModelConfig[] {
  const requiresVision = hasImageContext || (attachments ?? []).some((part) => part.type === "image" || part.type === "image_ref");
  const requiresFiles = (attachments ?? []).some((part) => part.type === "file" || part.type === "file_ref");
  const requiresTools = (allowedTools ?? []).length > 0;

  return models.filter((model) => {
    const caps = modelCapabilities(model.provider, model.model_id);
    if (requiresVision && !caps.vision) return false;
    if (requiresFiles && !caps.files) return false;
    if (requiresTools && !caps.tools) return false;
    if (routeClass === "research" && !caps.tools) return false;
    return true;
  });
}

function filterByHotContextBudget(
  models: readonly ModelConfig[],
  requiredHotContextTokens: number | null | undefined,
  contextTierProportions: ContextTierProportions | null | undefined,
): ModelConfig[] {
  if (!requiredHotContextTokens || requiredHotContextTokens <= 0) return [];
  return models.filter((model) => modelHotBudgetTokens(model, contextTierProportions) >= requiredHotContextTokens);
}

function modelContextWindowTokens(model: ModelConfig): number {
  const explicit = typeof model.params.context_window_tokens === "number" && model.params.context_window_tokens > 0
    ? model.params.context_window_tokens
    : null;
  const known = getKnownContextLength(model.provider, model.model_id);
  return explicit && known ? Math.min(explicit, known) : explicit ?? known ?? 8_192;
}

function modelHotBudgetTokens(
  model: ModelConfig,
  contextTierProportions: ContextTierProportions | null | undefined,
): number {
  return computeContextBudget({
    ...model.params,
    context_window_tokens: modelContextWindowTokens(model),
    context_tier_proportions: contextTierProportions ?? modelContextTierProportions(model),
  }).tierBudgets.hot;
}

function modelContextTierProportions(model: ModelConfig): ContextTierProportions | undefined {
  const raw = model.params.context_tier_proportions;
  return raw && typeof raw === "object" ? raw as ContextTierProportions : undefined;
}

function scoreCandidate(
  model: ModelConfig,
  routeClass: ModelRouteClass,
  options: RouteTurnModelOptions,
): number {
  const caps = modelCapabilities(model.provider, model.model_id);
  const functionality = detectModelFunctionality(model.model_id);
  const rateResolver = options.rateResolver ?? (() => ({ inputPer1M: null, outputPer1M: null }));
  const rates = rateResolver(model.provider, model.model_id);
  const estimatedCost = estimateTurnCost(routeClass, rates.inputPer1M, rates.outputPer1M);
  const cacheAffinity = latestCacheAffinity(model.name, options.latestUsage);
  const observationBias = latestObservationBias(model.name, options.latestObservation, options.policy);
  const contextWindow = modelContextWindowTokens(model);
  let score = 0;

  switch (routeClass) {
    case "simple-chat":
      score += functionality === "chat" ? 8 : 0;
      score += functionality === "reasoning" ? -10 : 0;
      score += FAST_MODEL_RE.test(model.model_id) ? 8 : 0;
      score += SLOW_MODEL_RE.test(model.model_id) ? -8 : 0;
      break;
    case "factual":
      score += caps.tools ? 8 : -12;
      score += caps.files ? 4 : 0;
      score += contextWindow >= 32_000 ? 4 : 0;
      score += functionality === "reasoning" ? 4 : 0;
      break;
    case "research":
      score += caps.tools ? 10 : -20;
      score += caps.files ? 8 : 0;
      score += caps.web_search ? 5 : 0;
      score += contextWindow >= 64_000 ? 8 : contextWindow >= 32_000 ? 4 : -4;
      score += functionality === "reasoning" ? 4 : 0;
      break;
    case "complex-reasoning":
      score += functionality === "reasoning" ? 14 : 0;
      score += SLOW_MODEL_RE.test(model.model_id) ? 8 : 0;
      score += FAST_MODEL_RE.test(model.model_id) ? -2 : 0;
      score += contextWindow >= 32_000 ? 3 : 0;
      break;
    case "multimodal":
      score += caps.vision ? 18 : -30;
      score += caps.files ? 4 : 0;
      score += caps.tools ? 4 : 0;
      break;
  }

  if (options.policy === "cheap") {
    score -= estimatedCost * 1200;
    score += cacheAffinity * 1.4;
    score += FAST_MODEL_RE.test(model.model_id) ? 4 : 0;
  } else if (options.policy === "fast") {
    score -= estimatedCost * 350;
    score += FAST_MODEL_RE.test(model.model_id) ? 8 : 0;
    score += SLOW_MODEL_RE.test(model.model_id) ? -10 : 0;
    score += cacheAffinity;
  } else if (options.policy === "quality") {
    score -= estimatedCost * 120;
    score += functionality === "reasoning" ? 8 : 0;
    score += SLOW_MODEL_RE.test(model.model_id) ? 6 : 0;
    score += cacheAffinity * 0.6;
  } else {
    score -= estimatedCost * 550;
    score += FAST_MODEL_RE.test(model.model_id) ? 3 : 0;
    score += functionality === "reasoning" && routeClass === "complex-reasoning" ? 6 : 0;
    score += cacheAffinity;
  }

  return score + observationBias;
}

function estimateTurnCost(
  routeClass: ModelRouteClass,
  inputPer1M: number | null,
  outputPer1M: number | null,
): number {
  const [inputTokens, outputTokens] = routeClass === "simple-chat"
    ? [1_200, 350]
    : routeClass === "factual"
      ? [2_500, 600]
      : routeClass === "research"
        ? [6_500, 1_100]
        : routeClass === "complex-reasoning"
          ? [4_500, 1_200]
          : [3_500, 900];
  const inRate = inputPer1M ?? 0.5;
  const outRate = outputPer1M ?? inRate * 2;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

function latestCacheAffinity(modelConfigName: string, usage?: LatestUsageHint | null): number {
  if (!usage || usage.model_config_name !== modelConfigName) return 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  // A warm cache hit represents a large token saving on the next turn. Score it
  // high enough to outweigh typical cost differences between model tiers so the
  // router stays sticky when caching is active. Switching models always forces a
  // cold cache write, which costs 1.25× AND throws away the savings.
  // cacheRead   > 0 → cache already warm, switching would definitely lose it (+30)
  // cacheCreate > 0 → cache was just written, sticking keeps it warm (+15)
  // no cache    → small continuity bonus to avoid gratuitous model switches on
  //               cold starts or after TTL expiry when cost differences are minor (+8)
  if (cacheRead > 0) return 30;
  if (cacheCreate > 0) return 15;
  return 8;
}

function latestObservationBias(
  modelConfigName: string,
  observation: RouteDecisionMetadata | null | undefined,
  policy: ModelRouterPolicy,
): number {
  if (!observation || observation.model_config_name !== modelConfigName) return 0;
  if (observation.terminal === "error") return -18;
  const duration = observation.duration_ms ?? 0;
  if (policy === "fast") {
    if (duration > 8_000) return -8;
    if (duration > 4_000) return -4;
    if (duration > 0 && duration < 2_500) return 4;
  }
  if ((observation.retry_count ?? 0) > 0) return -3;
  return observation.terminal === "done" ? 2 : 0;
}

export function finalizeRouteDecision(
  decision: RouteDecisionMetadata | null | undefined,
  outcome: RouteOutcome,
): RouteDecisionMetadata | null {
  if (!decision) return null;
  return {
    ...decision,
    duration_ms: outcome.durationMs,
    terminal: outcome.terminal,
    error_code: outcome.errorCode,
    retry_count: outcome.retryCount,
  };
}

export function nextPolicyForRetry(policy: ModelRouterPolicy): ModelRouterPolicy {
  if (policy === "cheap" || policy === "fast") return "balanced";
  if (policy === "balanced") return "quality";
  return "quality";
}