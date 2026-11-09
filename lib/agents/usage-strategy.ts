export const USAGE_STRATEGIES = ["cost_saving", "fast", "balanced", "high_reasoning"] as const;
export type UsageStrategy = typeof USAGE_STRATEGIES[number];
export type UsageRouterPolicy = "cheap" | "fast" | "balanced" | "quality";

export interface UsageStrategyProfile {
  routerPolicy: UsageRouterPolicy | null;
  enableRouter: boolean | null;
  contextWindowRatio: number;
  /** Ask thinking models to reason less (or not at all) when the provider supports it. */
  reduceThinking: boolean;
  stallRetries: number | null;
  providerFailureRetries: number | null;
  promptInstruction: string;
}

const PROFILES: Readonly<Record<UsageStrategy, UsageStrategyProfile>> = {
  cost_saving: {
    routerPolicy: "cheap",
    enableRouter: true,
    contextWindowRatio: 0.6,
    reduceThinking: true,
    stallRetries: 0,
    providerFailureRetries: 1,
    promptInstruction:
      "--- Economical response style ---\n" +
      "Answer in the fewest words that fully satisfy the request. Lead with the result. " +
      "Do not restate the request, narrate routine steps, or add unsolicited background. " +
      "Use bullets only when they improve scanning. Keep explanations, examples, and caveats to what the task requires. " +
      "Preserve accuracy, necessary safety caveats, and explicitly requested depth or format.",
  },
  fast: {
    routerPolicy: "fast",
    enableRouter: true,
    contextWindowRatio: 0.5,
    reduceThinking: true,
    stallRetries: 0,
    providerFailureRetries: 1,
    promptInstruction:
      "--- Fast response style ---\n" +
      "Prioritize a direct, low-latency response. Keep the answer focused, avoid unnecessary analysis and tool calls, and preserve accuracy and requested detail.",
  },
  balanced: {
    routerPolicy: null,
    enableRouter: null,
    contextWindowRatio: 0.8,
    reduceThinking: false,
    stallRetries: null,
    providerFailureRetries: null,
    promptInstruction: "",
  },
  high_reasoning: {
    routerPolicy: "quality",
    enableRouter: true,
    contextWindowRatio: 1,
    reduceThinking: false,
    stallRetries: null,
    providerFailureRetries: null,
    promptInstruction:
      "--- High-reasoning response style ---\n" +
      "For complex tasks, examine assumptions and relevant evidence, compare viable approaches, and verify consequential conclusions. Present key conclusions, evidence, and tradeoffs at a level appropriate to the request; do not expose private chain-of-thought.",
  },
};

export function parseUsageStrategy(value: unknown): UsageStrategy | null {
  return typeof value === "string" && (USAGE_STRATEGIES as readonly string[]).includes(value)
    ? value as UsageStrategy
    : null;
}

export function resolveUsageStrategy(agentOverride: unknown, globalStrategy: unknown): UsageStrategy {
  return parseUsageStrategy(agentOverride) ?? parseUsageStrategy(globalStrategy) ?? "balanced";
}

export function shouldAutoRecall(
  strategy: UsageStrategy,
  profileEnabled = true,
  forceEnabled = false,
): boolean {
  return profileEnabled && (strategy === "high_reasoning" || forceEnabled);
}

export function getUsageStrategyProfile(strategy: UsageStrategy): UsageStrategyProfile {
  return PROFILES[strategy];
}

export function applyTokenBudgetRatio(modelLimit: number, ratio: number): number {
  if (!Number.isFinite(modelLimit) || modelLimit < 1
    || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new RangeError("Token budget ratio requires a positive model limit and a ratio in (0, 1]");
  }
  return Math.max(1, Math.floor(modelLimit * ratio));
}
