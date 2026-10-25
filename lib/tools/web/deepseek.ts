import { getIntegrationRaw } from "@/lib/stores/integrations";
import { readResponseTextCapped } from "@/lib/utils/http-json";

const DEEPSEEK_TOOLS_URL = "https://api.deepseek.com/v1/tools";
const DEEPSEEK_TIMEOUT_MS = 30_000;
const MAX_DEEPSEEK_RESPONSE_BYTES = 1_000_000;

class DeepSeekWebError extends Error {}

export function getDeepSeekWebApiKey(): string | null {
  return getIntegrationRaw("deepseek-web")?.api_key?.trim() || null;
}

export async function postDeepSeekWebTool(
  endpoint: "search" | "fetch",
  apiKey: string,
  body: Record<string, unknown>,
  callerSignal?: AbortSignal,
  timeoutMs = DEEPSEEK_TIMEOUT_MS,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  const toolName = endpoint === "search" ? "Search" : "Fetch";
  try {
    const response = await fetch(`${DEEPSEEK_TOOLS_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });

    if (!response.ok) {
      await response.body?.cancel();
      const reason = response.status === 401
        ? "the API key is missing or invalid"
        : response.status === 402
          ? "the account has insufficient balance"
          : response.status === 403 && endpoint === "fetch"
            ? "the URL was rejected by DeepSeek's security policy"
            : response.status === 404 && endpoint === "fetch"
              ? "DeepSeek could not retrieve usable page content"
              : response.status === 429
                ? "the account request limit was exceeded"
                : "the provider rejected the request";
      throw new DeepSeekWebError(`DeepSeek ${toolName} failed (HTTP ${response.status}): ${reason}.`);
    }

    const { text, truncated } = await readResponseTextCapped(response, MAX_DEEPSEEK_RESPONSE_BYTES);
    if (truncated) throw new DeepSeekWebError("DeepSeek returned a response larger than 1 MB.");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DeepSeekWebError(`DeepSeek ${toolName} returned invalid JSON.`);
    }
  } catch (error) {
    if (error instanceof DeepSeekWebError) throw error;
    if (signal.aborted) {
      const timeoutError = new Error(`DeepSeek ${toolName} timed out or was cancelled after at most ${timeoutMs / 1000}s.`);
      timeoutError.name = "AbortError";
      throw timeoutError;
    }
    throw new DeepSeekWebError(`DeepSeek ${toolName} request failed. Check network connectivity and retry.`);
  }
}
