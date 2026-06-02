// Classifiers for provider-side errors (Anthropic / OpenAI / Gemini / etc.).
// The agent runtime in lib/agents/llm.ts catches whatever the provider SDK
// throws; without classification the user sees a raw stack trace and the
// agent has no signal about WHY the call failed.
//
// Each classifier matches against the error message + cause chain (the
// undici-flattened text llm.ts already builds). Returns true on match. Pure
// functions; testable without spinning up a provider.
//
// Codes returned here align with the ADR-0049 playbook so the same words
// the LLM sees on tool errors apply at the provider layer too.
//
// See ADR-0051.

export interface ProviderErrorInfo {
  code: string;
  /** Friendly user-facing message with a recovery hint. */
  message: string;
  /**
   * For transient codes (rate_limit, network_error), how long the run-thread
   * wrapper should pause before retrying. Undefined when the upstream gave
   * us no specific signal.
   */
  retryAfterMs?: number;
  /** True when the run-thread retry wrapper should auto-retry the turn. */
  retryable: boolean;
}

const AUTH_PATTERNS: RegExp[] = [
  /\b401\b/,
  /unauthor[iz]+ed/i,
  /authentication\s+failed/i,
  /invalid\s+(?:api\s*)?key/i,
  /api\s*key.*(?:invalid|missing|expired)/i,
  /AADSTS\d{5,}/i, // Azure / Microsoft identity error codes
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /quota.*exceeded/i,
  /requests\s+per\s+minute/i,
];

const BILLING_PATTERNS: RegExp[] = [
  /insufficient[_\s]*quota/i,
  /billing/i,
  /payment\s+required/i,
  /\b402\b/,
  /credit.*exhausted/i,
];

const MODEL_NOT_FOUND_PATTERNS: RegExp[] = [
  /model.*(?:not\s*found|does\s*not\s*exist|unsupported|unavailable)/i,
  /unsupported.*model/i,
  /model.*deprecated/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound|getaddrinfo/i,
  /und_err_socket/i,
  /fetch\s+failed/i,
  /socket\s+hang\s*up/i,
  /tunnel.*timeout/i,
  /proxy\s+CONNECT/i,
];

function anyMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function extractRetryAfterSeconds(text: string): number | undefined {
  // "Retry after 30 seconds", "Please wait 12s", "retry-after: 60"
  const m = text.match(/retry[\s\-]?after[:\s]*(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|milliseconds)?/i);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return undefined;
    const unit = (m[2] ?? "s").toLowerCase();
    return unit.startsWith("ms") ? Math.floor(n) : Math.floor(n * 1000);
  }
  return undefined;
}

/**
 * Run the catch-block error message through every classifier in priority
 * order. Returns null when nothing matches — caller falls back to its
 * existing generic "agent_error" path.
 *
 * Priority order matters: an auth error often *also* contains "401" + the
 * word "rate limit" in the body (some proxies stuff retry advice into 401
 * responses). Auth wins because the recovery is different (fix the key vs
 * wait + retry).
 */
export function classifyProviderError(message: string): ProviderErrorInfo | null {
  if (!message) return null;

  if (anyMatch(message, AUTH_PATTERNS)) {
    return {
      code: "auth_error",
      message:
        "The provider rejected the request — the API key looks invalid, missing, or expired. " +
        "Open Settings → Models → [your config] and verify the api_key field; for OAuth integrations " +
        "(Gmail, Outlook), reconnect the integration.",
      retryable: false,
    };
  }

  if (anyMatch(message, BILLING_PATTERNS)) {
    return {
      code: "billing_error",
      message:
        "The provider returned a billing/quota error — your plan may be over-budget or expired. " +
        "Check your provider account; switching to a different model config in this thread is the fastest workaround.",
      retryable: false,
    };
  }

  if (anyMatch(message, RATE_LIMIT_PATTERNS)) {
    return {
      code: "rate_limit",
      message:
        "The provider rate-limited this request. Retrying once after a short delay…",
      retryAfterMs: extractRetryAfterSeconds(message),
      retryable: true,
    };
  }

  if (anyMatch(message, MODEL_NOT_FOUND_PATTERNS)) {
    return {
      code: "model_not_found",
      message:
        "The configured model isn't available on this provider/region. Open Settings → Models, pick a different model_id, or check whether the provider deprecated this one.",
      retryable: false,
    };
  }

  if (anyMatch(message, NETWORK_PATTERNS)) {
    return {
      code: "network_error",
      message:
        "Network failure reaching the provider. Retrying once after a short delay…",
      // Default 2s backoff for network blips; classifier doesn't have a
      // server-supplied hint to use.
      retryAfterMs: 2_000,
      retryable: true,
    };
  }

  return null;
}
