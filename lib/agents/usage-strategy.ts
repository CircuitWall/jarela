export const USAGE_STRATEGIES = ["cost_saving", "fast", "balanced", "high_reasoning"] as const;
export type UsageStrategy = typeof USAGE_STRATEGIES[number];
export type UsageRouterPolicy = "cheap" | "fast" | "balanced" | "quality";

export interface UsageStrategyProfile {
  routerPolicy: UsageRouterPolicy | null;
  enableRouter: boolean | null;
  contextWindowCapTokens: number | null;
  outputTokenCap: number | null;
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
    contextWindowCapTokens: 65_536,
    outputTokenCap: 2_048,
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
    contextWindowCapTokens: 32_768,
    outputTokenCap: 2_048,
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
    contextWindowCapTokens: null,
    outputTokenCap: null,
    reduceThinking: false,
    stallRetries: null,
    providerFailureRetries: null,
    promptInstruction: "",
  },
  high_reasoning: {
    routerPolicy: "quality",
    enableRouter: true,
    contextWindowCapTokens: null,
    outputTokenCap: null,
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

export function shouldAutoRecall(strategy: UsageStrategy, profileEnabled = true): boolean {
  return strategy === "high_reasoning" && profileEnabled;
}

export function getUsageStrategyProfile(strategy: UsageStrategy): UsageStrategyProfile {
  return PROFILES[strategy];
}

// Reasoning tokens share the output budget; below this a thinking model can
// spend the whole cap on its chain of thought and return nothing.
export const THINKING_OUTPUT_FLOOR_TOKENS = 32_768;

export function resolveOutputTokenCap(
  profileCap: number | null,
  modelThinks: boolean,
  strategy: UsageStrategy,
): number | null {
  if (profileCap === null) return null;
  if (modelThinks && strategy !== "cost_saving") {
    return Math.max(profileCap, THINKING_OUTPUT_FLOOR_TOKENS);
  }
  return profileCap;
}