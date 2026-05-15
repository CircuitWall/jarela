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
    case "internal":    return fetchInternalCatalog();
    case "openai":  return fetchOpenAICatalog();
    case "github-copilot": return fetchGitHubCopilotCatalog();
    case "anthropic": return anthropicKnownModels();
    default: return [];
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────────

async function fetchInternalCatalog(): Promise<CatalogModel[]> {
  const cfg = listModelConfigs().find((c) => c.provider === "internal");
  if (!cfg) throw new Error("No custom-provider model config found. Add one in the Models panel first.");

  const params = JSON.parse(cfg.params) as Record<string, unknown>;
  const token = await resolveInternalToken(params);

  const res = await fetch("https://genai-api.internal.example.com/genai-api/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Internal catalog error: ${res.status}`);

  const data = await res.json() as { models: InternalModel[] };

  return data.models
    .filter((m) => m.model_type === "chat")
    .map((m): CatalogModel => {
      const fs = m.feature_support ?? {};
      return {
        id: m.model_name,
        context_length: m.context_length ?? null,
        max_output_tokens: m.model_max_tokens ?? null,
        hosted_on: m.cloud_hosted ?? null,
        capabilities: {
          vision:    !!fs.vision,
          tools:     !!fs.function_calling,
          streaming: !!fs.streaming,
          json_mode: !!fs.json_mode,
          web_search: !!fs.web_search,
        },
      };
    });
}

async function resolveInternalToken(params: Record<string, unknown>): Promise<string> {
  const apiKey = params.api_key as string | undefined;
  if (apiKey?.startsWith("eyJ")) return apiKey;

  const username = params.username as string | undefined;
  const password = params.password as string | undefined;
  if (!username || !password) throw new Error("Internal: set api_key (JWT) or username + password");

  const res = await fetch("https://genai-api.internal.example.com/genai-api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Internal login failed: ${res.status}`);
  const json = await res.json() as { access_token?: string; accessToken?: string };
  const token = json.access_token ?? json.accessToken;
  if (!token) throw new Error("Internal login: no token in response");
  return token;
}

interface InternalModel {
  model_name: string;
  model_type: string;
  context_length?: number;
  model_max_tokens?: number;
  cloud_hosted?: string;
  feature_support?: {
    vision?: boolean;
    function_calling?: boolean;
    streaming?: boolean;
    json_mode?: boolean;
    web_search?: boolean;
  };
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
  const apiKey = (params.api_key as string | undefined) ?? process.env.GITHUB_TOKEN;
  if (!apiKey) throw new Error("GitHub Copilot: no api_key configured.");

  const res = await fetch("https://api.githubcopilot.com/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Copilot-Integration-Id": "vscode-chat",
    },
  });
  if (!res.ok) throw new Error(`GitHub Copilot catalog error: ${res.status}`);
  const data = await res.json() as { data: Array<{ id: string; capabilities?: { supports?: { tool_calls?: boolean; streaming?: boolean; parallel_tool_calls?: boolean } } }> };

  return data.data.map((m): CatalogModel => ({
    id: m.id,
    context_length: null,
    max_output_tokens: null,
    hosted_on: "github",
    capabilities: {
      vision:    false,
      tools:     m.capabilities?.supports?.tool_calls ?? false,
      streaming: m.capabilities?.supports?.streaming ?? true,
      json_mode: false,
      web_search: false,
    },
  }));
}

// ── Anthropic (static) ────────────────────────────────────────────────────────

function anthropicKnownModels(): CatalogModel[] {
  return [
    { id: "claude-opus-4-7",        context_length: 1000000, max_output_tokens: 8192,  hosted_on: "anthropic", capabilities: { vision: true,  tools: true, streaming: true, json_mode: false, web_search: false } },
    { id: "claude-sonnet-4-6",      context_length: 200000,  max_output_tokens: 8192,  hosted_on: "anthropic", capabilities: { vision: true,  tools: true, streaming: true, json_mode: false, web_search: false } },
    { id: "claude-haiku-4-5-20251001", context_length: 200000, max_output_tokens: 4096, hosted_on: "anthropic", capabilities: { vision: true, tools: true, streaming: true, json_mode: false, web_search: false } },
  ];
}
