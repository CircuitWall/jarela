import { NextRequest, NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";
import { listModelConfigs, getModelParams } from "@/lib/stores/model-config";
import type { ProviderCatalogModel, ProviderParams } from "@/lib/providers/types";
import {
  getKnownContextLength,
  getKnownMaxOutputTokens,
} from "@/lib/providers/known-context-windows";

export interface CatalogModel {
  id: string;
  context_length: number | null;
  max_output_tokens: number | null;
  hosted_on: string | null;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    json_mode: boolean;
    web_search: boolean;
    audio: boolean;
    files: boolean;
  };
}

type Params = { params: Promise<{ provider: string }> };

// Live provider catalogs (OpenAI, GitHub Copilot) hit external APIs on every
// call; static ones still cost JSON construction. Cache per-provider for a
// short TTL so flipping panels / model browsers doesn't re-hit upstream.
const PROVIDER_CATALOG_TTL_MS = 10 * 60 * 1000;
type CachedCatalog = { data: CatalogModel[]; fetchedAt: number };
const catalogCache = new Map<string, CachedCatalog>();

async function getCachedCatalog(provider: string, force: boolean): Promise<CatalogModel[]> {
  const now = Date.now();
  if (!force) {
    const cached = catalogCache.get(provider);
    if (cached && now - cached.fetchedAt < PROVIDER_CATALOG_TTL_MS) return cached.data;
  }
  const data = await fetchCatalog(provider);
  catalogCache.set(provider, { data, fetchedAt: now });
  return data;
}

export async function GET(req: NextRequest, { params }: Params) {
  const { provider } = await params;
  const force = req.nextUrl.searchParams.get("fresh") === "1";

  try {
    const models = await getCachedCatalog(provider, force);
    return NextResponse.json(models, {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function fetchCatalog(provider: string): Promise<CatalogModel[]> {
  switch (provider) {
    case "openai":  return fetchOpenAICatalog();
    case "github-copilot": return fetchGitHubCopilotCatalog();
    case "anthropic": return anthropicKnownModels();
    case "gemini":  return geminiKnownModels();
    case "deepseek": return deepseekKnownModels();
    default: return fetchExternalCatalog(provider);
  }
}

async function fetchExternalCatalog(providerName: string): Promise<CatalogModel[]> {
  let provider;
  try {
    provider = getProvider(providerName);
  } catch {
    return [];
  }
  if (!provider.listModels) return [];

  const cfg = listModelConfigs().find((c) => c.provider === providerName);
  const params: ProviderParams = getModelParams(cfg);
  const models = await provider.listModels(params);
  return models as ProviderCatalogModel[];
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function fetchOpenAICatalog(): Promise<CatalogModel[]> {
  const cfg = listModelConfigs().find((c) => c.provider === "openai");
  if (!cfg) throw new Error("No OpenAI model config found.");
  const params = getModelParams(cfg);
  const apiKey = (params.api_key as string | undefined) ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI: no api_key configured.");

  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI catalog error: ${res.status}`);
  const data = await res.json() as { data: Array<{ id: string }> };

  const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
  const chatModels = data.data
    .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
    .map((m): CatalogModel => ({
      id: m.id,
      context_length: getKnownContextLength("openai", m.id),
      max_output_tokens: getKnownMaxOutputTokens("openai", m.id),
      hosted_on: "azure/openai",
      capabilities: {
        vision:    m.id.includes("vision") || m.id.startsWith("gpt-4"),
        tools:     true,
        streaming: true,
        json_mode: true,
        web_search: false,
        audio:     m.id.includes("audio") || m.id.startsWith("gpt-4o") || m.id.startsWith("gpt-5"),
        files:     m.id.startsWith("gpt-4") || m.id.startsWith("gpt-5") || m.id.startsWith("o"),
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return chatModels;
}

// ── GitHub Copilot ────────────────────────────────────────────────────────────

async function fetchGitHubCopilotCatalog(): Promise<CatalogModel[]> {
  // We deliberately do NOT return the broad GitHub Models cross-publisher
  // registry here — that lists hundreds of models from every vendor, which is
  // confusing when the user is configuring the "github-copilot" provider
  // specifically. We mirror what Copilot Chat actually serves: its own
  // /models endpoint when we have an exchangeable credential, else a curated
  // fallback list. Users who want the raw GitHub Models catalog can type the
  // namespaced model id directly into the Model ID field.

  // 1. Prefer the in-app device-flow OAuth token — it can be exchanged.
  const { getStoredOAuthToken } = await import("@/lib/providers/github-copilot-auth");
  const oauth = getStoredOAuthToken();
  if (oauth) {
    try {
      const sessionToken = await exchangeCopilotSessionToken(oauth);
      const list = await fetchCopilotChatCatalog(sessionToken);
      if (list.length > 0) return list;
    } catch { /* fall through */ }
  }

  // 2. Look up a saved github-copilot model config for an explicit session
  //    token or a non-PAT credential that supports exchange.
  const cfg = listModelConfigs().find((c) => c.provider === "github-copilot");
  if (cfg) {
    const params = getModelParams(cfg);
    const sessionTok = (params.copilot_session_token as string | undefined)?.trim();
    if (sessionTok) {
      try {
        const list = await fetchCopilotChatCatalog(sessionTok);
        if (list.length > 0) return list;
      } catch { /* fall through */ }
    }
    const apiKey = (params.api_key as string | undefined) ?? process.env.GITHUB_TOKEN;
    if (apiKey && !isLikelyGitHubPat(apiKey)) {
      try {
        const sessionToken = await exchangeCopilotSessionToken(apiKey);
        const list = await fetchCopilotChatCatalog(sessionToken);
        if (list.length > 0) return list;
      } catch { /* fall through */ }
    }
  }

  // 3. Fallback: curated known-models list. Works even on a PAT — those
  //    model IDs are valid on both Models API and Copilot Chat.
  return githubCopilotKnownModels();
}

async function fetchCopilotChatCatalog(sessionToken: string): Promise<CatalogModel[]> {
  const res = await fetch("https://api.githubcopilot.com/models", {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Editor-Version": "vscode/1.85.0",
      "Copilot-Integration-Id": "vscode-chat",
      "openai-intent": "conversation-ai",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub Copilot catalog error: ${res.status} ${body}`);
  }
  const data = await res.json() as { data: Array<{ id: string; capabilities?: { supports?: { tool_calls?: boolean; streaming?: boolean; vision?: boolean } } }> };

  return data.data.map((m): CatalogModel => ({
    id: m.id,
    context_length: getKnownContextLength("github-copilot", m.id),
    max_output_tokens: getKnownMaxOutputTokens("github-copilot", m.id),
    hosted_on: "github",
    capabilities: {
      vision: m.capabilities?.supports?.vision ?? false,
      tools: m.capabilities?.supports?.tool_calls ?? false,
      streaming: m.capabilities?.supports?.streaming ?? true,
      json_mode: false,
      web_search: false,
      audio: false,
      files: m.capabilities?.supports?.vision ?? false,
    },
  }));
}

function isLikelyGitHubPat(token: string): boolean {
  return token.startsWith("ghp_") || token.startsWith("github_pat_") || token.startsWith("gho_");
}

async function exchangeCopilotSessionToken(pat: string): Promise<string> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${pat}`,
      "User-Agent": "Jarela/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub Copilot token exchange failed: ${res.status} ${body}`);
  }

  const json = await res.json() as { token?: string };
  if (!json.token) throw new Error("GitHub Copilot token exchange returned no token");
  return json.token;
}

function githubCopilotKnownModels(): CatalogModel[] {
  // Curated fallback — mirrors what the VS Code Copilot Chat picker exposes.
  // Used only when the live /models endpoint isn't reachable (no OAuth token
  // stored, exchange failed, etc.). Keep in sync with Copilot's current line-up.
  const v = (id: string, vision = false, tools = true): CatalogModel => ({
    id,
    context_length: getKnownContextLength("github-copilot", id),
    max_output_tokens: getKnownMaxOutputTokens("github-copilot", id),
    hosted_on: "github",
    capabilities: { vision, tools, streaming: true, json_mode: false, web_search: false, audio: false, files: vision },
  });
  return [
    // OpenAI family
    v("gpt-4o", true),
    v("gpt-4.1", true),
    v("gpt-4.1-mini", true),
    v("gpt-5", true),
    v("gpt-5-mini", true),
    v("o1", false),
    v("o3", false),
    v("o3-mini", false),
    v("o4-mini", false),
    // Anthropic family
    v("claude-opus-4-7", true),
    v("claude-sonnet-4-6", true),
    v("claude-sonnet-4", true),
    v("claude-3.7-sonnet", true),
    v("claude-haiku-4-5", true),
    // Google family
    v("gemini-2.5-pro", true),
    v("gemini-2.5-flash", true),
    v("gemini-2.0-flash", true),
  ];
}

// ── Anthropic (static) ────────────────────────────────────────────────────────

function anthropicKnownModels(): CatalogModel[] {
  return [
    { id: "claude-opus-4-7",        context_length: 1000000, max_output_tokens: 8192,  hosted_on: "anthropic", capabilities: { vision: true,  tools: true, streaming: true, json_mode: false, web_search: true,  audio: false, files: true } },
    { id: "claude-sonnet-4-6",      context_length: 200000,  max_output_tokens: 8192,  hosted_on: "anthropic", capabilities: { vision: true,  tools: true, streaming: true, json_mode: false, web_search: true,  audio: false, files: true } },
    { id: "claude-haiku-4-5-20251001", context_length: 200000, max_output_tokens: 4096, hosted_on: "anthropic", capabilities: { vision: true, tools: true, streaming: true, json_mode: false, web_search: true, audio: false, files: true } },
  ];
}

// ── Gemini (static) ───────────────────────────────────────────────────────────

function geminiKnownModels(): CatalogModel[] {
  return [
    { id: "gemini-2.5-pro",          context_length: 1048576, max_output_tokens: 65536,  hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: true,  audio: true,  files: true } },
    { id: "gemini-2.5-flash",        context_length: 1048576, max_output_tokens: 65536,  hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: true,  audio: true,  files: true } },
    { id: "gemini-2.0-flash",        context_length: 1048576, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: true,  audio: true,  files: true } },
    { id: "gemini-2.0-flash-lite",   context_length: 1048576, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false, audio: true,  files: true } },
    { id: "gemini-1.5-pro",          context_length: 2097152, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false, audio: true,  files: true } },
    { id: "gemini-1.5-flash",        context_length: 1048576, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false, audio: true,  files: true } },
  ];
}

// ── DeepSeek (static) ─────────────────────────────────────────────────────────

function deepseekKnownModels(): CatalogModel[] {
  return [
    { id: "deepseek-v4-flash", context_length: 65536,  max_output_tokens: 8192, hosted_on: "deepseek", capabilities: { vision: false, tools: true,  streaming: true, json_mode: true,  web_search: false, audio: false, files: false } },
    { id: "deepseek-v4-pro",   context_length: 65536,  max_output_tokens: 8192, hosted_on: "deepseek", capabilities: { vision: false, tools: true,  streaming: true, json_mode: true,  web_search: false, audio: false, files: false } },
    // Compatibility aliases currently accepted by DeepSeek (scheduled deprecation 2026-07-24).
    { id: "deepseek-chat",     context_length: 65536,  max_output_tokens: 8192, hosted_on: "deepseek", capabilities: { vision: false, tools: true,  streaming: true, json_mode: true,  web_search: false, audio: false, files: false } },
    { id: "deepseek-reasoner", context_length: 65536,  max_output_tokens: 8192, hosted_on: "deepseek", capabilities: { vision: false, tools: false, streaming: true, json_mode: false, web_search: false, audio: false, files: false } },
  ];
}
