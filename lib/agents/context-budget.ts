import type { MessageRow } from "@/lib/stores/threads";
import { transcriptText } from "@/lib/agents/conversation-summary";

export type ContextTier = "hot" | "warm" | "facts";

export type ContextTierPriority = [ContextTier, ContextTier, ContextTier];

export interface ContextTierProportions {
  hot?: number;
  warm?: number;
  facts?: number;
}

export interface ContextBudgetConfig {
  context_window_tokens?: number;
  max_tokens?: number;
  context_tier_proportions?: ContextTierProportions;
  context_tier_priority?: ContextTierPriority | readonly ContextTier[] | unknown;
}

export interface ContextBudget {
  contextWindowTokens: number;
  outputReserveTokens: number;
  inputBudgetTokens: number;
  overheadTokens: number;
  tierBudgets: Record<ContextTier, number>;
  tierPriority: ContextTierPriority;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;
const DEFAULT_OVERHEAD_TOKENS = 1_200;
const DEFAULT_OUTPUT_RESERVE_RATIO = 0.2;
const DEFAULT_TIER_PRIORITY: ContextTierPriority = ["hot", "warm", "facts"];
const DEFAULT_TIER_PROPORTIONS: Required<ContextTierProportions> = {
  hot: 0.6,
  warm: 0.25,
  facts: 0.15,
};

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function normalizeTierPriority(value: ContextBudgetConfig["context_tier_priority"]): ContextTierPriority {
  if (!Array.isArray(value)) return DEFAULT_TIER_PRIORITY;
  const tiers = value.filter((v): v is ContextTier => v === "hot" || v === "warm" || v === "facts");
  if (tiers.length !== 3) return DEFAULT_TIER_PRIORITY;
  if (new Set(tiers).size !== 3) return DEFAULT_TIER_PRIORITY;
  return [tiers[0], tiers[1], tiers[2]];
}

export function normalizeTierProportions(value: ContextTierProportions | undefined): Required<ContextTierProportions> {
  const hot = toPositiveNumber(value?.hot, DEFAULT_TIER_PROPORTIONS.hot);
  const warm = toPositiveNumber(value?.warm, DEFAULT_TIER_PROPORTIONS.warm);
  const facts = toPositiveNumber(value?.facts, DEFAULT_TIER_PROPORTIONS.facts);
  const sum = hot + warm + facts;
  if (sum <= 0) return DEFAULT_TIER_PROPORTIONS;
  return {
    hot: hot / sum,
    warm: warm / sum,
    facts: facts / sum,
  };
}

export function computeContextBudget(config: ContextBudgetConfig): ContextBudget {
  const contextWindowTokens = Math.max(
    1,
    Math.floor(config.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
  );
  const outputReserveTokens = Math.max(
    256,
    Math.min(
      contextWindowTokens - 1,
      Math.floor(config.max_tokens ?? contextWindowTokens * DEFAULT_OUTPUT_RESERVE_RATIO),
    ),
  );
  const overheadTokens = Math.max(0, Math.min(DEFAULT_OVERHEAD_TOKENS, contextWindowTokens - outputReserveTokens));
  const inputBudgetTokens = Math.max(0, contextWindowTokens - outputReserveTokens - overheadTokens);
  const proportions = normalizeTierProportions(config.context_tier_proportions);
  const tierPriority = normalizeTierPriority(config.context_tier_priority);
  const tierBudgets = {
    hot: Math.floor(inputBudgetTokens * proportions.hot),
    warm: Math.floor(inputBudgetTokens * proportions.warm),
    facts: Math.max(0, inputBudgetTokens - Math.floor(inputBudgetTokens * proportions.hot) - Math.floor(inputBudgetTokens * proportions.warm)),
  } satisfies Record<ContextTier, number>;

  return {
    contextWindowTokens,
    outputReserveTokens,
    inputBudgetTokens,
    overheadTokens,
    tierBudgets,
    tierPriority,
  };
}

export function takeRecentMessagesWithinBudget(messages: readonly MessageRow[], tokenBudget: number): MessageRow[] {
  if (tokenBudget <= 0 || messages.length === 0) return [];
  const chosen: MessageRow[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const tokens = estimateTokens(transcriptText(msg.content));
    if (chosen.length > 0 && used + tokens > tokenBudget) break;
    chosen.push(msg);
    used += tokens;
    if (used >= tokenBudget) break;
  }
  return chosen.reverse();
}

export function formatContextBudgetSummary(budget: ContextBudget): string {
  const parts = [
    `window ${budget.contextWindowTokens} tokens`,
    `output reserve ${budget.outputReserveTokens}`,
    `input budget ${budget.inputBudgetTokens}`,
    `hot ${budget.tierBudgets.hot}`,
    `warm ${budget.tierBudgets.warm}`,
    `facts ${budget.tierBudgets.facts}`,
  ];
  return parts.join(" · ");
}

function toPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}