import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProvider } from "@/lib/providers";
import { modelCapabilities } from "@/lib/providers/capabilities";
import { listModelConfigs, getModelParams } from "@/lib/stores/model-config";
import type { ProviderCatalogModel, ProviderParams } from "@/lib/providers/types";
import { validateBody, errorJson } from "@/lib/api/responses";
import {
  getKnownContextLength,
  getKnownMaxOutputTokens,
} from "@/lib/providers/known-context-windows";
import { readErrorBody } from "@/lib/utils/error";
import { listModelMetadata, resolvedModelMetadata, type ModelMetadata } from "@/lib/stores/model-metadata";

export interface CatalogModel {
  model_metadata?: ModelMetadata;
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

const CatalogBody = z.object({
  params: z.record(z.string(), z.unknown()).optional(),
});

// Live provider catalogs hit external APIs. Cache per-provider briefly so
// opening the model browser repeatedly doesn't re-hit upstream.
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
    return NextResponse.json(withModelMetadata(provider, models), {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

// Raised when the saved configuration itself is unusable, so callers get a
// 4xx they can act on instead of a generic server error.
class CatalogConfigError extends Error {}

function catalogErrorResponse(err: unknown): NextResponse {
  const status = err instanceof CatalogConfigError ? 400 : 500;
  return errorJson({ error: String(err) }, { status });
}

// POST allows the editor to ship the in-form credentials (api_key /
// base_url / extra_headers) before the user has saved them. We never cache
// these responses since they're keyed on user-supplied secrets.
export async function POST(req: NextRequest, { params }: Params) {
  const { provider } = await params;
  const body = await validateBody(req, CatalogBody);
  if (body instanceof NextResponse) return body;
  try {
    const models = await fetchCatalog(provider, body.params);
    catalogCache.delete(provider);
    return NextResponse.json(withModelMetadata(provider, models), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

function withModelMetadata(provider: string, models: CatalogModel[]): CatalogModel[] {
  const metadata = listModelMetadata(provider);
  return models.map((model) => {
    const observed = resolvedModelMetadata(provider, model.id, metadata);
    const capabilities = { ...model.capabilities };
    for (const [key, claim] of Object.entries(observed.model_metadata?.capabilities ?? {})) {
      if (claim) Object.assign(capabilities, { [key]: claim.value });
    }
    return { ...model, capabilities, model_metadata: observed.model_metadata };
  });
}

async function fetchCatalog(provider: string, overrides?: ProviderParams): Promise<CatalogModel[]> {
  switch (provider) {
    case "openai":  return fetchOpenAICatalog(overrides);
    case "github-copilot": return fetchGitHubCopilotCatalog();
    case "anthropic": return fetchAnthropicCatalog(overrides);
    case "gemini":  return fetchGeminiCatalog(overrides);
    case "deepseek": return fetchDeepseekCatalog(overrides);
    default: return fetchExternalCatalog(provider, overrides);
  }
}

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

function catalogParamsCandidates(provider: string, overrides?: ProviderParams): ProviderParams[] {
  const envKey = process.env[PROVIDER_API_KEY_ENV[provider] ?? ""];
  const configs = listModelConfigs().filter((cfg) => cfg.provider === provider);
  const candidates = configs.map((cfg) => {
    const params = { ...getModelParams(cfg), ...(overrides ?? {}) };
    if (!params.api_key && envKey) params.api_key = envKey;
    return params;
  });

  if (overrides) {
    const params = { ...overrides };
    if (!params.api_key && envKey) params.api_key = envKey;
    candidates.push(params);
  }
  if (candidates.length === 0 && envKey) candidates.push({ api_key: envKey });
  if (candidates.length === 0) candidates.push({});
  return candidates;
}

async function fetchConfiguredCatalog(
  provider: string,
  overrides: ProviderParams | undefined,
  fetcher: (params: ProviderParams, apiKey: string) => Promise<CatalogModel[]>,
  fallback: () => CatalogModel[],
): Promise<CatalogModel[]> {
  const candidates = catalogParamsCandidates(provider, overrides)
    .filter((params): params is ProviderParams & { api_key: string } =>
      typeof params.api_key === "string" && params.api_key.length > 0,
    );
  if (candidates.length === 0) return fallback();

  let lastErr: unknown;
  for (const params of candidates) {
    try {
      return await fetcher(params, params.api_key);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`${provider} catalog request failed`);
}

async function requestCatalogJson<T>(provider: string, url: URL, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${provider} catalog error: ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchExternalCatalog(providerName: string, overrides?: ProviderParams): Promise<CatalogModel[]> {
  let provider;
  try {
    provider = getProvider(providerName);
  } catch {
    return [];
  }
  if (!provider.listModels) return [];

  // Try each saved config for this provider, plus the caller overrides.
  // Some providers ship multiple configs where only some carry usable
  // credentials; picking the first row blindly fails as soon as another
  // row is misconfigured. Overrides are merged on top of each candidate,
  // then also tried standalone, so a freshly-typed api_key works before
  // the user has saved it.
  const cfgs = listModelConfigs().filter((c) => c.provider === providerName);
  const candidates: ProviderParams[] = cfgs.map((c) => ({
    ...getModelParams(c),
    ...(overrides ?? {}),
  }));
  if (overrides && Object.keys(overrides).length > 0) candidates.push(overrides);
  if (candidates.length === 0) candidates.push(overrides ?? {});

  let lastErr: unknown;
  for (const params of candidates) {
    try {
      const models = await provider.listModels(params);
      return models as ProviderCatalogModel[];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`${providerName}: no usable credentials for catalog`);
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function fetchOpenAICatalog(overrides?: ProviderParams): Promise<CatalogModel[]> {
  return fetchConfiguredCatalog("openai", overrides, async (params, apiKey) => {
    const url = endpointUrl(params.base_url, "https://api.openai.com/v1", "/models");
    const data = await requestCatalogJson<{ data?: Array<{ id: string }> }>("OpenAI", url, {
      headers: {
        ...params.extra_headers,
        Authorization: "Bearer " + apiKey,
      },
    });
    const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
    return (data.data ?? [])
      .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
      .map((m): CatalogModel => ({
        id: m.id,
        context_length: getKnownContextLength("openai", m.id),
        max_output_tokens: getKnownMaxOutputTokens("openai", m.id),
        hosted_on: "azure/openai",
        capabilities: {
          vision: m.id.includes("vision") || m.id.startsWith("gpt-4"),
          tools: true,
          streaming: true,
          json_mode: true,
          web_search: false,
          audio: m.id.includes("audio") || m.id.startsWith("gpt-4o") || m.id.startsWith("gpt-5"),
          files: m.id.startsWith("gpt-4") || m.id.startsWith("gpt-5") || m.id.startsWith("o"),
        },
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, () => {
    throw new Error("OpenAI: no api_key configured.");
  });
}

async function fetchAnthropicCatalog(overrides?: ProviderParams): Promise<CatalogModel[]> {
  return fetchConfiguredCatalog("anthropic", overrides, async (params, apiKey) => {
    const url = endpointUrl(params.base_url, "https://api.anthropic.com", "/v1/models");
    url.searchParams.set("limit", "1000");
    const models: Array<{
      id: string;
      max_input_tokens?: number | null;
      max_tokens?: number | null;
      capabilities?: {
        image_input?: { supported?: boolean };
        pdf_input?: { supported?: boolean };
        structured_outputs?: { supported?: boolean };
        server_tools?: { web_search?: { supported?: boolean } };
      };
    }> = [];
    let afterId: string | undefined;

    do {
      const pageUrl = new URL(url);
      if (afterId) pageUrl.searchParams.set("after_id", afterId);
      const page = await requestCatalogJson<{
        data?: typeof models;
        has_more?: boolean;
        last_id?: string | null;
      }>("Anthropic", pageUrl, {
        headers: {
          ...params.extra_headers,
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      models.push(...(page.data ?? []));
      if (page.has_more && !page.last_id) throw new Error("Anthropic catalog response is missing its next-page cursor");
      if (page.has_more && page.last_id === afterId) throw new Error("Anthropic catalog pagination did not advance");
      afterId = page.has_more ? page.last_id ?? undefined : undefined;
    } while (afterId);

    return models.map((model): CatalogModel => {
      const known = modelCapabilities("anthropic", model.id);
      const vision = model.capabilities?.image_input?.supported ?? known.vision;
      return {
        id: model.id,
        context_length: model.max_input_tokens ?? getKnownContextLength("anthropic", model.id),
        max_output_tokens: model.max_tokens ?? getKnownMaxOutputTokens("anthropic", model.id),
        hosted_on: "anthropic",
        capabilities: {
          vision,
          tools: known.tools,
          streaming: known.streaming,
          json_mode: model.capabilities?.structured_outputs?.supported ?? known.json_mode,
          web_search: model.capabilities?.server_tools?.web_search?.supported ?? known.web_search,
          audio: known.audio,
          files: model.capabilities?.pdf_input?.supported ?? known.files,
        },
      };
    });
  }, anthropicKnownModels);
}

async function fetchGeminiCatalog(overrides?: ProviderParams): Promise<CatalogModel[]> {
  return fetchConfiguredCatalog("gemini", overrides, async (params, apiKey) => {
    const url = endpointUrl(
      params.gemini_native_base_url,
      "https://generativelanguage.googleapis.com/v1beta",
      "/models",
    );
    url.searchParams.set("pageSize", "1000");
    const models: Array<{
      name: string;
      inputTokenLimit?: number;
      outputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }> = [];
    let pageToken: string | undefined;

    do {
      const pageUrl = new URL(url);
      if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
      const page = await requestCatalogJson<{
        models?: typeof models;
        nextPageToken?: string;
      }>("Gemini", pageUrl, { headers: { "x-goog-api-key": apiKey } });
      models.push(...(page.models ?? []));
      if (page.nextPageToken && page.nextPageToken === pageToken) {
        throw new Error("Gemini catalog pagination did not advance");
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return models
      .map((model): CatalogModel | null => {
        const id = model.name.replace(/^models\//, "");
        if (!id.startsWith("gemini-") ||
            !model.supportedGenerationMethods?.includes("generateContent")) return null;
        return {
          id,
          context_length: model.inputTokenLimit ?? getKnownContextLength("gemini", id),
          max_output_tokens: model.outputTokenLimit ?? getKnownMaxOutputTokens("gemini", id),
          hosted_on: "google",
          capabilities: modelCapabilities("gemini", id),
        };
      })
      .filter((model): model is CatalogModel => model !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }, geminiKnownModels);
}

async function fetchDeepseekCatalog(overrides?: ProviderParams): Promise<CatalogModel[]> {
  return fetchConfiguredCatalog("deepseek", overrides, async (params, apiKey) => {
    const url = endpointUrl(params.base_url, "https://api.deepseek.com", "/models");
    const data = await requestCatalogJson<{
      data?: Array<{
        id: string;
        context_window?: number;
        max_output_tokens?: number;
        input_modalities?: string[];
      }>;
    }>("DeepSeek", url, {
      headers: {
        ...params.extra_headers,
        Authorization: "Bearer " + apiKey,
      },
    });
    return (data.data ?? []).map((model): CatalogModel => {
      const known = modelCapabilities("deepseek", model.id);
      const vision = model.input_modalities?.includes("image") ?? known.vision;
      return {
        id: model.id,
        context_length: model.context_window ?? getKnownContextLength("deepseek", model.id),
        max_output_tokens: model.max_output_tokens ?? getKnownMaxOutputTokens("deepseek", model.id),
        hosted_on: "deepseek",
        capabilities: {
          ...known,
          vision,
          audio: model.input_modalities?.includes("audio") ?? known.audio,
        },
      };
    });
  }, deepseekKnownModels);
}

function endpointUrl(baseUrl: unknown, defaultBaseUrl: string, path: string): URL {
  const base = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : defaultBaseUrl;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Provider base URL must be a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider base URL must use HTTP or HTTPS");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  const suffix = path === "/v1/models" && normalizedPath.endsWith("/v1") ? "/models" : path;
  url.pathname = `${normalizedPath}${suffix}` || "/";
  url.search = "";
  url.hash = "";
  return url;
}

// ── GitHub Copilot ────────────────────────────────────────────────────────────

async function fetchGitHubCopilotCatalog(): Promise<CatalogModel[]> {
  // Use Copilot Chat's account-specific /models endpoint when an exchangeable
  // credential is available, otherwise return a curated fallback list.

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
    // Only the Copilot config's own api_key is considered: GITHUB_TOKEN belongs
    // to the GitHub integration and is usually a PAT unrelated to Copilot.
    const apiKey = (params.api_key as string | undefined)?.trim();
    if (apiKey && isLikelyGitHubPat(apiKey)) {
      throw new CatalogConfigError(
        "GitHub Copilot: PAT model discovery used GitHub Models, which has been retired. " +
        "Use device-flow sign-in in the Models panel or set copilot_session_token.",
      );
    }
    if (apiKey) {
      try {
        const sessionToken = await exchangeCopilotSessionToken(apiKey);
        const list = await fetchCopilotChatCatalog(sessionToken);
        if (list.length > 0) return list;
      } catch { /* fall through */ }
    }
  }

  // 3. Fallback: curated known-models list when no credential can be exchanged.
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
    const body = await readErrorBody(res);
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
  return token.startsWith("ghp_") || token.startsWith("github_pat_");
}

async function exchangeCopilotSessionToken(githubToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${githubToken}`,
      "User-Agent": "Jarela/1.0",
    },
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
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
    // V4.1 Flash is natively multimodal; V4 Pro is text-only (api-docs.deepseek.com/quick_start/pricing).
    { id: "deepseek-flash",   context_length: 1000000, max_output_tokens: 384000, hosted_on: "deepseek", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false, audio: false, files: false } },
    { id: "deepseek-v4-pro", context_length: 1000000, max_output_tokens: 384000, hosted_on: "deepseek", capabilities: { vision: false, tools: true, streaming: true, json_mode: true, web_search: false, audio: false, files: false } },
  ];
}
