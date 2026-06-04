import OpenAI from "openai";
import type {
  ModelProvider,
  ProviderParams,
  ProviderStreamResult,
  ProviderStreamEvent,
  InvokeResult,
} from "./types";
import { getStoredOAuthToken } from "./github-copilot-auth";
import { parseOpenAIInvokeChoice, streamOpenAIEvents, toOpenAIMessages } from "./openai";

function pickGitHubCompatOptions(params: ProviderParams): Record<string, unknown> {
  const p = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = [
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "stop",
    "response_format",
    "logprobs",
    "top_logprobs",
    "reasoning_effort",
    "thinking",
    "stream_options",
    "user",
    "user_id",
  ];
  for (const k of keys) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

interface SessionToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, SessionToken>();

function isLikelyGitHubPat(token: string): boolean {
  return token.startsWith("ghp_") || token.startsWith("github_pat_") || token.startsWith("gho_");
}

async function getCopilotToken(pat: string): Promise<string> {
  if (!pat) throw new Error("GitHub Copilot: no API key configured for token exchange.");
  const cached = tokenCache.get(pat);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${pat}`,
      "User-Agent": "Jarela/1.0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    if (res.status === 401) {
      throw new Error(
        `GitHub Copilot: token exchange failed (401). ` +
        `Ensure your PAT has the "copilot" scope and that you have an active Copilot subscription. ` +
        `Details: ${body}`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        "GitHub Copilot token exchange endpoint was not found for this credential. " +
        "Personal Access Tokens are not accepted directly by Copilot chat. " +
        "Use a Copilot session token in params.copilot_session_token, or a credential that supports token exchange.",
      );
    }
    throw new Error(`GitHub Copilot: token exchange failed (${res.status}): ${body}`);
  }

  const json = await res.json() as { token: string; expires_at: string };
  if (!json.token) throw new Error("GitHub Copilot: token exchange returned no token");

  const expiresAt = json.expires_at ? new Date(json.expires_at).getTime() : Date.now() + 28 * 60_000;
  tokenCache.set(pat, { token: json.token, expiresAt });
  return json.token;
}

const FIXED_HEADERS = {
  "Editor-Version": "vscode/1.85.0",
  "Copilot-Integration-Id": "vscode-chat",
  "openai-intent": "conversation-ai",
  // Required by the Copilot proxy to accept image_url content parts. Without
  // this header the upstream models silently drop attached images (or 400).
  "Copilot-Vision-Request": "true",
};

async function resolvedClient(params: ProviderParams): Promise<OpenAI> {
  const apiKey = (params.api_key as string | undefined) ?? "";
  const explicitSessionToken = (params.copilot_session_token as string | undefined)?.trim();

  // Highest priority: an explicit pre-exchanged Copilot session token.
  if (explicitSessionToken && explicitSessionToken.length > 0) {
    return new OpenAI({
      apiKey: explicitSessionToken,
      baseURL: params.base_url ?? "https://api.githubcopilot.com",
      defaultHeaders: { ...FIXED_HEADERS, ...params.extra_headers },
    });
  }

  // Next: a device-flow OAuth token persisted by the in-app sign-in. This is
  // exchangeable for a Copilot session token, so we get full model context.
  const oauthToken = getStoredOAuthToken();
  if (oauthToken) {
    const token = await getCopilotToken(oauthToken);
    return new OpenAI({
      apiKey: token,
      baseURL: params.base_url ?? "https://api.githubcopilot.com",
      defaultHeaders: { ...FIXED_HEADERS, ...params.extra_headers },
    });
  }

  // Fallback: a raw PAT. PATs can't be exchanged for Copilot tokens, so they
  // route to the GitHub Models REST API (which enforces tight per-request
  // token caps, e.g. 8000 for gpt-4o). Users who want larger contexts should
  // sign in via the device flow instead.
  if (apiKey && isLikelyGitHubPat(apiKey)) {
    return new OpenAI({
      apiKey,
      baseURL: params.base_url ?? "https://models.github.ai/inference",
      defaultHeaders: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...params.extra_headers,
      },
    });
  }

  // Otherwise, treat the credential as an OAuth-capable token and exchange.
  if (!apiKey) {
    throw new Error(
      "GitHub Copilot: not signed in. Use the in-app device-flow login, or set api_key / copilot_session_token.",
    );
  }
  const token = await getCopilotToken(apiKey);
  return new OpenAI({
    apiKey: token,
    baseURL: params.base_url ?? "https://api.githubcopilot.com",
    defaultHeaders: { ...FIXED_HEADERS, ...params.extra_headers },
  });
}

export const githubCopilotProvider: ModelProvider = {
  name: "github-copilot",

  async chat(model_id, messages, params): Promise<ProviderStreamResult> {
    const client = await resolvedClient(params);
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      stream: true,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      ...(pickGitHubCompatOptions(params) as Record<string, unknown>),
    });
    return {
      stream: (async function* () {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) yield delta;
        }
      })(),
    };
  },

  async invoke(model_id, messages, params, tools): Promise<InvokeResult> {
    const client = await resolvedClient(params);
    const resp = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: false,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      ...(pickGitHubCompatOptions(params) as Record<string, unknown>),
    });
    return parseOpenAIInvokeChoice(resp.choices[0]);
  },

  async *streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    const client = await resolvedClient(params);
    const compat = pickGitHubCompatOptions(params) as Record<string, unknown>;
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: true,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      ...compat,
      stream_options: { include_usage: true, ...(compat.stream_options as object | undefined) },
    });

    yield* streamOpenAIEvents(
      stream as AsyncIterable<{
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
      }>,
    );
  },

  async embed(model_id, inputs, params): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const client = await resolvedClient(params);
    const resp = await client.embeddings.create({
      model: model_id,
      input: inputs,
    });
    return resp.data.map((d) => d.embedding);
  },
};
