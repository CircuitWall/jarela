import { NextRequest, NextResponse } from "next/server";
import { listModelConfigs } from "@/lib/stores/model-config";

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
  };
}

type Params = { params: Promise<{ provider: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { provider } = await params;

  try {
    const models = await fetchCatalog(provider);
    return NextResponse.json(models);
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
    default: return [];
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function fetchOpenAICatalog(): Promise<CatalogModel[]> {
  const cfg = listModelConfigs().find((c) => c.provider === "openai");
  if (!cfg) throw new Error("No OpenAI model config found.");
  const params = JSON.parse(cfg.params) as Record<string, unknown>;
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
      context_length: null,
      max_output_tokens: null,
      hosted_on: "azure/openai",
      capabilities: {
        vision:    m.id.includes("vision") || m.id.startsWith("gpt-4"),
        tools:     true,
        streaming: true,
        json_mode: true,
        web_search: false,
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
    const params = JSON.parse(cfg.params) as Record<string, unknown>;
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
    context_length: null,
    max_output_tokens: null,
    hosted_on: "github",
    capabilities: {
      vision: m.capabilities?.supports?.vision ?? false,
      tools: m.capabilities?.supports?.tool_calls ?? false,
      streaming: m.capabilities?.supports?.streaming ?? true,
      json_mode: false,
      web_search: false,
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
      "User-Agent": "LangGUI/1.0",
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
  return [
    { id: "gpt-4o", context_length: null, max_output_tokens: null, hosted_on: "github", capabilities: { vision: true, tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "gpt-4.1", context_length: null, max_output_tokens: null, hosted_on: "github", capabilities: { vision: true, tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "o3", context_length: null, max_output_tokens: null, hosted_on: "github", capabilities: { vision: false, tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "claude-sonnet-4", context_length: null, max_output_tokens: null, hosted_on: "github", capabilities: { vision: true, tools: true, streaming: true, json_mode: false, web_search: false } },
    { id: "claude-3.7-sonnet", context_length: null, max_output_tokens: null, hosted_on: "github", capabilities: { vision: true, tools: true, streaming: true, json_mode: false, web_search: false } },
    { id: "gemini-2.0-flash", context_length: null, max_output_tokens: null, hosted_on: "github", capabilities: { vision: true, tools: true, streaming: true, json_mode: true, web_search: false } },
  ];
}

// ── Anthropic (static) ────────────────────────────────────────────────────────

function anthropicKnownModels(): CatalogModel[] {
  return [
    { id: "claude-opus-4-7",        context_length: 1000000, max_output_tokens: 8192,  hosted_on: "anthropic", capabilities: { vision: true,  tools: true, streaming: true, json_mode: false, web_search: false } },
    { id: "claude-sonnet-4-6",      context_length: 200000,  max_output_tokens: 8192,  hosted_on: "anthropic", capabilities: { vision: true,  tools: true, streaming: true, json_mode: false, web_search: false } },
    { id: "claude-haiku-4-5-20251001", context_length: 200000, max_output_tokens: 4096, hosted_on: "anthropic", capabilities: { vision: true, tools: true, streaming: true, json_mode: false, web_search: false } },
  ];
}

// ── Gemini (static) ───────────────────────────────────────────────────────────

function geminiKnownModels(): CatalogModel[] {
  return [
    { id: "gemini-2.5-pro",          context_length: 1048576, max_output_tokens: 65536,  hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "gemini-2.5-flash",        context_length: 1048576, max_output_tokens: 65536,  hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "gemini-2.0-flash",        context_length: 1048576, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "gemini-2.0-flash-lite",   context_length: 1048576, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "gemini-1.5-pro",          context_length: 2097152, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false } },
    { id: "gemini-1.5-flash",        context_length: 1048576, max_output_tokens: 8192,   hosted_on: "google", capabilities: { vision: true,  tools: true, streaming: true, json_mode: true, web_search: false } },
  ];
}

// ── DeepSeek (static) ─────────────────────────────────────────────────────────

function deepseekKnownModels(): CatalogModel[] {
  return [
    { id: "deepseek-chat",     context_length: 65536,  max_output_tokens: 8192, hosted_on: "deepseek", capabilities: { vision: false, tools: true,  streaming: true, json_mode: true,  web_search: false } },
    { id: "deepseek-reasoner", context_length: 65536,  max_output_tokens: 8192, hosted_on: "deepseek", capabilities: { vision: false, tools: false, streaming: true, json_mode: false, web_search: false } },
  ];
}
