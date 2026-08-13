import { getIntegrationRaw } from "@/lib/stores/integrations";

export const CLAUDE_CODE_INTEGRATION = "claude-code";

export interface ClaudeCodeConfig {
  bin: string;
  apiKey?: string;
  env: Record<string, string>;
}

export function getClaudeCodeConfig(): ClaudeCodeConfig {
  const raw = getIntegrationRaw(CLAUDE_CODE_INTEGRATION);
  const bin = raw?.cli_path?.trim() || process.env.JARELA_CLAUDE_BIN?.trim() || "claude";
  const apiKey = raw?.api_key?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  return {
    bin,
    apiKey,
    env: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {},
  };
}