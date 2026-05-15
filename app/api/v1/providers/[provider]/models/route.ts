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
  const cfg = listModelConfigs().find((c) => c.provider === "github-copilot");
  if (!cfg) throw new Error("No GitHub Copilot model config found.");
  const params = JSON.parse(cfg.params) as Record<string, unknown>;
  const pat = (params.api_key as string | undefined) ?? process.env.GITHUB_TOKEN;

  if (pat && isLikelyGitHubPat(pat)) {
    return fetchGitHubModelsCatalog(pat);
  }

  if (!pat) return githubCopilotKnownModels();

  try {
    const sessionToken = await exchangeCopilotSessionToken(pat);
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
    const data = await res.json() as { data: Array<{ id: string; capabilities?: { supports?: { tool_calls?: boolean; streaming?: boolean; parallel_tool_calls?: boolean } } }> };

    return data.data.map((m): CatalogModel => ({
      id: m.id,
      context_length: null,
      max_output_tokens: null,
      hosted_on: "github",
      capabilities: {
        vision: false,
        tools: m.capabilities?.supports?.tool_calls ?? false,
        streaming: m.capabilities?.supports?.streaming ?? true,
        json_mode: false,
        web_search: false,
      },
    }));
  } catch {
    // Keep model selection usable even when account/token cannot query catalog.
    return githubCopilotKnownModels();
  }
}

function isLikelyGitHubPat(token: string): boolean {
  return token.startsWith("ghp_") || token.startsWith("github_pat_") || token.startsWith("gho_");
}

async function fetchGitHubModelsCatalog(token: string): Promise<CatalogModel[]> {
  const res = await fetch("https://models.github.ai/catalog/models", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub Models catalog error: ${res.status} ${body}`);
  }

  const data = await res.json() as Array<{
    id: string;
    registry?: string;
    capabilities?: string[];
    limits?: { max_input_tokens?: number; max_output_tokens?: number };
    supported_input_modalities?: string[];
  }>;

  return data.map((m): CatalogModel => {
    const caps = new Set((m.capabilities ?? []).map((c) => c.toLowerCase()));
    const inputs = new Set((m.supported_input_modalities ?? []).map((c) => c.toLowerCase()));
    return {
      id: m.id,
      context_length: m.limits?.max_input_tokens ?? null,
      max_output_tokens: m.limits?.max_output_tokens ?? null,
      hosted_on: m.registry ?? "github-models",
      capabilities: {
        vision: inputs.has("image"),
        tools: caps.has("tool-calling") || caps.has("tools"),
        streaming: caps.has("streaming"),
        json_mode: caps.has("json-mode") || caps.has("json_mode"),
        web_search: caps.has("web-search") || caps.has("web_search"),
      },
    };
  });
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
