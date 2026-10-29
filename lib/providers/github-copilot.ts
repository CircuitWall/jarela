import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ModelProvider,
  ProviderParams,
  ProviderStreamResult,
  ProviderStreamEvent,
  InvokeResult,
} from "./types";
import { getStoredOAuthToken } from "./github-copilot-auth";
import { readErrorBody } from "@/lib/utils/error";
import { openaiTokenLimitParams, parseOpenAIInvokeChoice, streamOpenAIEvents, toOpenAIMessages } from "./openai";
import {
  ANTHROPIC_API_VERSION,
  buildAnthropicMessageBody,
  translateAnthropicStreamEvents,
} from "./anthropic";

// Claude-family Copilot model ids include the upstream Anthropic names
// (`claude-3.5-sonnet`, `claude-sonnet-4`, `claude-opus-4`, …) and a few
// GitHub-rebranded aliases (`Github-Opus4.6`, `copilot-claude-3.5-sonnet`).
// Same normalization rule as `resolveCopilot()` in known-context-windows.ts.
export function isCopilotClaudeModel(model_id: string): boolean {
  if (!model_id) return false;
  const n = model_id.replace(/^(?:Github-|copilot-)/i, "").toLowerCase();
  return n.startsWith("claude") || n.startsWith("opus") || n.startsWith("sonnet") || n.startsWith("haiku");
}

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

function isGitHubPat(token: string): boolean {
  return token.startsWith("ghp_") || token.startsWith("github_pat_");
}

async function exchangeCopilotSessionToken(githubToken: string): Promise<string> {
  if (!githubToken) throw new Error("GitHub Copilot: no API key configured for token exchange.");
  const cached = tokenCache.get(githubToken);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  tokenCache.delete(githubToken);

  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${githubToken}`,
      "User-Agent": "Jarela/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (res.status === 401) {
      throw new Error(
        `GitHub Copilot: token exchange failed (401). ` +
        `Check that this GitHub account has an active Copilot subscription and the credential is valid. ` +
        `Details: ${body}`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        "GitHub Copilot could not exchange this credential for a session token. " +
        "Use the in-app device-flow sign-in or set params.copilot_session_token.",
      );
    }
    throw new Error(`GitHub Copilot: token exchange failed (${res.status}): ${body}`);
  }

  const json = await res.json() as { token: string; expires_at: string };
  if (!json.token) throw new Error("GitHub Copilot: token exchange returned no token");

  const expiresAt = json.expires_at ? new Date(json.expires_at).getTime() : Date.now() + 28 * 60_000;
  tokenCache.set(githubToken, { token: json.token, expiresAt });
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
  const auth = await resolveCopilotAuth(params);
  return new OpenAI({
    apiKey: auth.apiKey,
    baseURL: auth.baseURL,
    defaultHeaders: { ...auth.headers, ...params.extra_headers },
    maxRetries: 0,
  });
}

// Resolves credentials for Copilot's OpenAI-compatible and native Messages APIs.
type CopilotAuth = { baseURL: string; apiKey: string; headers: Record<string, string> };

async function resolveCopilotAuth(params: ProviderParams): Promise<CopilotAuth> {
  const apiKey = (params.api_key as string | undefined) ?? "";
  const explicitSessionToken = (params.copilot_session_token as string | undefined)?.trim();

  if (explicitSessionToken && explicitSessionToken.length > 0) {
    return {
      baseURL: params.base_url ?? "https://api.githubcopilot.com",
      apiKey: explicitSessionToken,
      headers: { ...FIXED_HEADERS },
    };
  }

  const oauthToken = getStoredOAuthToken();
  if (oauthToken) {
    const token = await exchangeCopilotSessionToken(oauthToken);
    return {
      baseURL: params.base_url ?? "https://api.githubcopilot.com",
      apiKey: token,
      headers: { ...FIXED_HEADERS },
    };
  }

  if (apiKey && isGitHubPat(apiKey)) {
    throw new Error(
      "GitHub Copilot: this provider's GitHub PAT route used GitHub Models, which has been retired. " +
      "Use the in-app device-flow sign-in or set copilot_session_token.",
    );
  }

  if (!apiKey) {
    throw new Error(
      "GitHub Copilot: not signed in. Use the in-app device-flow login, or set api_key / copilot_session_token.",
    );
  }
  const token = await exchangeCopilotSessionToken(apiKey);
  return {
    baseURL: params.base_url ?? "https://api.githubcopilot.com",
    apiKey: token,
    headers: { ...FIXED_HEADERS },
  };
}

// Anthropic SDK client pointed at Copilot's native `/v1/messages` endpoint.
// Copilot accepts the Anthropic request shape (including `cache_control`
// ephemeral breakpoints) for Claude-family models when called with a
// Copilot session token.
async function resolvedAnthropicClient(params: ProviderParams): Promise<Anthropic> {
  const auth = await resolveCopilotAuth(params);
  return new Anthropic({
    // The SDK's authToken option sets the Authorization header expected by Copilot.
    authToken: auth.apiKey,
    baseURL: auth.baseURL,
    defaultHeaders: {
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...auth.headers,
      ...params.extra_headers,
    },
    maxRetries: 0,
  });
}

export const githubCopilotProvider: ModelProvider = {
  name: "github-copilot",

  async chat(model_id, messages, params, signal): Promise<ProviderStreamResult> {
    if (isCopilotClaudeModel(model_id)) {
      const client = await resolvedAnthropicClient(params);
      const body = buildAnthropicMessageBody(model_id, messages, params, []);
      const stream = client.messages.stream(body, { signal });
      return {
        stream: (async function* () {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              yield event.delta.text;
            }
          }
        })(),
      };
    }
    const client = await resolvedClient(params);
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      stream: true,
      temperature: params.temperature,
      ...openaiTokenLimitParams(model_id, params),
      ...(pickGitHubCompatOptions(params) as Record<string, unknown>),
    }, { signal });
    return {
      stream: (async function* () {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) yield delta;
        }
      })(),
    };
  },

  async invoke(model_id, messages, params, tools, signal): Promise<InvokeResult> {
    if (isCopilotClaudeModel(model_id)) {
      const client = await resolvedAnthropicClient(params);
      const body = buildAnthropicMessageBody(model_id, messages, params, tools);
      const resp = await client.messages.create(body as Anthropic.Messages.MessageCreateParamsNonStreaming, { signal });
      const textContent = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = resp.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> }));
      return {
        text: textContent || null,
        tool_calls: toolCalls,
        stop_reason: resp.stop_reason === "tool_use" ? "tool_use" : resp.stop_reason === "max_tokens" ? "length" : "stop",
      };
    }
    const client = await resolvedClient(params);
    const resp = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: false,
      temperature: params.temperature,
      ...openaiTokenLimitParams(model_id, params),
      ...(pickGitHubCompatOptions(params) as Record<string, unknown>),
    }, { signal });
    return parseOpenAIInvokeChoice(resp.choices[0]);
  },

  async *streamInvoke(model_id, messages, params, tools, signal): AsyncIterable<ProviderStreamEvent> {
    if (isCopilotClaudeModel(model_id)) {
      const client = await resolvedAnthropicClient(params);
      const body = buildAnthropicMessageBody(model_id, messages, params, tools);
      const stream = client.messages.stream(body, { signal });
      yield* translateAnthropicStreamEvents(stream);
      return;
    }
    const client = await resolvedClient(params);
    const compat = pickGitHubCompatOptions(params) as Record<string, unknown>;
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: toOpenAIMessages(messages),
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: true,
      temperature: params.temperature,
      ...openaiTokenLimitParams(model_id, params),
      ...compat,
      stream_options: { include_usage: true, ...(compat.stream_options as object | undefined) },
    }, { signal });

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
