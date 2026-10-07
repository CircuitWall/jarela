export const USAGE_STRATEGIES = ["cost_saving", "fast", "balanced", "high_reasoning"] as const;
export type UsageStrategy = typeof USAGE_STRATEGIES[number];
export type UsageRouterPolicy = "cheap" | "fast" | "balanced" | "quality";

export interface UsageStrategyProfile {
  routerPolicy: UsageRouterPolicy | null;
  enableRouter: boolean | null;
  contextWindowCapTokens: number | null;
  outputTokenCap: number | null;
  stallRetries: number | null;
  providerFailureRetries: number | null;
  promptInstruction: string;
}

const PROFILES: Readonly<Record<UsageStrategy, UsageStrategyProfile>> = {
  cost_saving: {
    routerPolicy: "cheap",
    enableRouter: true,
    contextWindowCapTokens: 32_768,
    outputTokenCap: 2_048,
    stallRetries: 0,
    providerFailureRetries: 1,
    promptInstruction:
      "--- Cost-saving response style ---\n" +
      "Prefer concise, direct answers. Use only the context and tool calls needed to finish the task; avoid repeating work or expanding scope. Preserve accuracy, safety, and requested detail.",
  },
  fast: {
    routerPolicy: "fast",
    enableRouter: true,
    contextWindowCapTokens: 32_768,
    outputTokenCap: 2_048,
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
    stallRetries: null,
    providerFailureRetries: null,
    promptInstruction: "",
  },
  high_reasoning: {
    routerPolicy: "quality",
    enableRouter: true,
    contextWindowCapTokens: null,
    outputTokenCap: null,
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

export function getUsageStrategyProfile(strategy: UsageStrategy): UsageStrategyProfile {
  return PROFILES[strategy];
}