import { getIntegrationRaw } from "@/lib/stores/integrations";

export const CLAUDE_CODE_INTEGRATION = "claude-code";

export type ClaudeCodePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
export type ClaudeCodeSyncMemory = "in" | "out" | "both" | false;

export interface ClaudeCodeLaunchDefaults {
  model?: string;
  tools?: string;
  addDirs?: string[];
  permissionMode?: ClaudeCodePermissionMode;
  allowUnsafe?: boolean;
  background?: boolean;
  timeoutSeconds?: number;
  syncMemory?: ClaudeCodeSyncMemory;
  escalateQuestions?: boolean;
}

export interface ClaudeCodeConfig {
  bin: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  env: Record<string, string>;
  launchDefaults: ClaudeCodeLaunchDefaults;
}

const PERMISSION_MODES = new Set<ClaudeCodePermissionMode>(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);

function clean(v: string | undefined): string | undefined {
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

function boolFromString(v: string | undefined): boolean | undefined {
  const s = clean(v)?.toLowerCase();
  if (!s) return undefined;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

function positiveNumberFromString(v: string | undefined): number | undefined {
  const s = clean(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function listFromString(v: string | undefined): string[] | undefined {
  const s = clean(v);
  if (!s) return undefined;
  const items = s.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function permissionModeFromString(v: string | undefined): ClaudeCodePermissionMode | undefined {
  const s = clean(v);
  return s && PERMISSION_MODES.has(s as ClaudeCodePermissionMode) ? s as ClaudeCodePermissionMode : undefined;
}

function syncMemoryFromString(v: string | undefined): ClaudeCodeSyncMemory | undefined {
  const s = clean(v)?.toLowerCase();
  if (!s) return undefined;
  if (s === "in" || s === "out" || s === "both") return s;
  if (["false", "off", "none", "no", "0"].includes(s)) return false;
  return undefined;
}

function first(rawValue: string | undefined, envValue: string | undefined): string | undefined {
  return clean(rawValue) ?? clean(envValue);
}

export function getClaudeCodeConfig(): ClaudeCodeConfig {
  // UI-managed integration config is authoritative. Env vars remain as a
  // compatibility/runtime fallback for service installs.
  const raw = getIntegrationRaw(CLAUDE_CODE_INTEGRATION);
  const bin = first(raw?.cli_path, process.env.JARELA_CLAUDE_BIN) ?? "claude";
  const rawApiKey = clean(raw?.api_key) ?? "";
  const rawAuthToken = clean(raw?.auth_token) ?? "";
  // If the UI row picks one auth mode, do not silently inject the other from env.
  const apiKey = rawApiKey
    ? rawApiKey
    : rawAuthToken
      ? undefined
      : clean(process.env.ANTHROPIC_API_KEY);
  const authToken = rawAuthToken
    ? rawAuthToken
    : rawApiKey
      ? undefined
      : clean(process.env.ANTHROPIC_AUTH_TOKEN);
  const baseUrl = first(raw?.base_url, process.env.ANTHROPIC_BASE_URL);
  const defaultOpusModel = first(raw?.default_opus_model, process.env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  const defaultSonnetModel = first(raw?.default_sonnet_model, process.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  const defaultHaikuModel = first(raw?.default_haiku_model, process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  const launchDefaults: ClaudeCodeLaunchDefaults = {
    model: first(raw?.default_model, process.env.JARELA_CLAUDE_DEFAULT_MODEL),
    tools: first(raw?.default_tools, process.env.JARELA_CLAUDE_DEFAULT_TOOLS),
    addDirs: listFromString(first(raw?.default_add_dirs, process.env.JARELA_CLAUDE_DEFAULT_ADD_DIRS)),
    permissionMode: permissionModeFromString(first(raw?.default_permission_mode, process.env.JARELA_CLAUDE_DEFAULT_PERMISSION_MODE)),
    allowUnsafe: boolFromString(first(raw?.default_allow_unsafe, process.env.JARELA_CLAUDE_DEFAULT_ALLOW_UNSAFE)),
    background: boolFromString(first(raw?.default_background, process.env.JARELA_CLAUDE_DEFAULT_BACKGROUND)),
    timeoutSeconds: positiveNumberFromString(first(raw?.default_timeout_seconds, process.env.JARELA_CLAUDE_DEFAULT_TIMEOUT_SECONDS)),
    syncMemory: syncMemoryFromString(first(raw?.default_sync_memory, process.env.JARELA_CLAUDE_DEFAULT_SYNC_MEMORY)),
    escalateQuestions: boolFromString(first(raw?.default_escalate_questions, process.env.JARELA_CLAUDE_DEFAULT_ESCALATE_QUESTIONS)),
  };
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
    launchDefaults,
  };
}