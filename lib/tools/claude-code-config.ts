import { getIntegrationRaw } from "@/lib/stores/integrations";

export const CLAUDE_CODE_INTEGRATION = "claude-code";

export interface ClaudeCodeConfig {
  bin: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  env: Record<string, string>;
}

export function getClaudeCodeConfig(): ClaudeCodeConfig {
  // UI-managed integration config is authoritative. Env vars remain as a
  // compatibility/runtime fallback for service installs.
  const raw = getIntegrationRaw(CLAUDE_CODE_INTEGRATION);
  const bin = raw?.cli_path?.trim() || process.env.JARELA_CLAUDE_BIN?.trim() || "claude";
  const rawApiKey = raw?.api_key?.trim() || "";
  const rawAuthToken = raw?.auth_token?.trim() || "";
  // If the UI row picks one auth mode, do not silently inject the other from env.
  const apiKey = rawApiKey
    ? rawApiKey
    : rawAuthToken
      ? undefined
      : process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const authToken = rawAuthToken
    ? rawAuthToken
    : rawApiKey
      ? undefined
      : process.env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined;
  const baseUrl = raw?.base_url?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const defaultOpusModel = raw?.default_opus_model?.trim() || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || undefined;
  const defaultSonnetModel = raw?.default_sonnet_model?.trim() || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || undefined;
  const defaultHaikuModel = raw?.default_haiku_model?.trim() || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || undefined;
  const env: Record<string, string> = {};
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
  // Explicitly blank the opposite auth var when the UI selected one mode.
  // This prevents inherited process env values from silently overriding intent.
  if (!rawApiKey && rawAuthToken) env.ANTHROPIC_API_KEY = "";
  if (rawApiKey && !rawAuthToken) env.ANTHROPIC_AUTH_TOKEN = "";
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (defaultOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultOpusModel;
  if (defaultSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = defaultSonnetModel;
  if (defaultHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaultHaikuModel;
  return {
    bin,
    apiKey,
    authToken,
    baseUrl,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    env,
  };
}