// Shared auth-error primitive for provider adapters.
//
// Motivation: Gemini's provider adapter transparently falls back from the
// native REST endpoint to the OpenAI-compat endpoint on any thrown error.
// When the error is "API_KEY_INVALID", both endpoints will fail with the
// same key, so the fallback wastes a round-trip AND masks the real cause
// behind the compat endpoint's less specific 400. We throw a typed
// ProviderAuthError so the adapter can skip the fallback, and the chat
// runtime can surface a friendly banner that deep-links to the offending
// credential in /settings/credentials. See ADR-0068.

export class ProviderAuthError extends Error {
  readonly code = "auth_failed" as const;
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderAuthError";
    this.provider = provider;
    this.status = status;
  }
}

// HTTP status codes that unambiguously mean "the credential is wrong /
// revoked / rate-limited-with-auth-context". 429 is intentionally NOT
// here — that's a quota/throttle problem, not an auth one, and the
// runtime response should be to back off rather than tell the user to
// re-enter their key.
export function isAuthHttpStatus(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

// Provider-agnostic heuristic over the error MESSAGE (not the exception
// type). Used by the chat runtime because some providers throw plain
// `Error("… 400 { API_KEY_INVALID }")` strings that never see a
// ProviderAuthError instance. Kept conservative so we don't misclassify
// context-window or rate-limit errors as auth.
export function isAuthErrorMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return (
    /API_KEY_INVALID/i.test(msg) ||
    /\binvalid[_\s-]*api[_\s-]*key\b/i.test(msg) ||
    /\bincorrect api key\b/i.test(msg) ||
    /\bauthentication[_\s-]*(error|failed|required)\b/i.test(msg) ||
    /\bunauthorized\b/i.test(msg) ||
    /\bforbidden\b/i.test(msg) ||
    /\bpermission[_\s-]*denied\b/i.test(msg) ||
    // Common HTTP status prefixes on provider error strings, but ONLY when
    // paired with an auth-y noun so we don't grab 401-in-a-model-name-etc.
    /\b(401|403)\b[^0-9]*(unauthorized|forbidden|permission|token|api[_\s-]*key|credential)/i.test(msg) ||
    // Google/Gemini prefixes it as "Request had invalid authentication credentials"
    /invalid authentication credentials/i.test(msg) ||
    // OAuth refresh-token expired
    /(refresh|access)[_\s-]*token[_\s-]*(expired|revoked|invalid)/i.test(msg)
  );
}
