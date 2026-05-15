import OpenAI from "openai";
import type {
  ModelProvider,
  ProviderParams,
  ProviderStreamResult,
  ProviderStreamEvent,
  InvokeResult,
} from "./types";

interface SessionToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, SessionToken>();

async function getCopilotToken(pat: string): Promise<string> {
  const cached = tokenCache.get(pat);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${pat}`,
      "User-Agent": "LangGUI/1.0",
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
};

async function resolvedClient(params: ProviderParams): Promise<OpenAI> {
  const pat = (params.api_key as string | undefined) ?? "";
  if (!pat) throw new Error("GitHub Copilot: no API key (GitHub PAT) configured.");
  const sessionToken = await getCopilotToken(pat);
  return new OpenAI({
    apiKey: sessionToken,
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
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      stream: true,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
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
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: false,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    });
    const choice = resp.choices[0];
    return {
      text: choice.message.content ?? null,
      tool_calls: (choice.message.tool_calls ?? []).flatMap((tc) => {
        if (!tc?.function?.name) return [];
        return [{
          id: tc.id,
          name: tc.function.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              return {};
            }
          })(),
        }];
      }),
      stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "stop",
    };
  },

  async *streamInvoke(model_id, messages, params, tools): AsyncIterable<ProviderStreamEvent> {
    const client = await resolvedClient(params);
    const stream = await client.chat.completions.create({
      model: model_id,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      tool_choice: "auto",
      stream: true,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    });

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as Record<string, unknown>;
      if (delta.content) yield { type: "text", delta: delta.content as string };
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
          yield {
            type: "tool_call_chunk",
            index: tc.index ?? 0,
            id: tc.id,
            name: tc.function?.name,
            args_delta: tc.function?.arguments,
          };
        }
      }
      if (choice.finish_reason) {
        const fr = choice.finish_reason;
        yield { type: "stop", reason: fr === "tool_calls" ? "tool_use" : fr === "length" ? "length" : "stop" };
      }
    }
  },
};
