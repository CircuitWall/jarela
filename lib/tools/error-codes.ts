// Shared error-code vocabulary for tool failures. The agent branches on
// these codes via the playbook in lib/agents/prepare/system-prompt.ts;
// keeping the mapping in one place ensures every HTTP-touching tool emits
// the same code for the same kind of failure.
//
// See ADR-0049.

/**
 * Map an HTTP response status to a stable error code the agent can branch
 * on. Don't expand this without also extending the playbook in
 * `lib/agents/prepare/system-prompt.ts#buildToolErrorPlaybook`, otherwise
 * the agent has no instruction for the new code and falls back to the
 * generic `tool_threw` handling.
 */
export function httpStatusToErrorCode(status: number): string {
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 404) return "http_404";
  if (status === 429) return "http_429";
  if (status >= 500 && status < 600) return "http_5xx";
  if (status >= 400 && status < 500) return "http_4xx";
  return "http_error";
}

/**
 * Classify a Node `fetch` exception (DNS failure, timeout, abort, etc.)
 * Network errors before the HTTP request even completes manifest as TypeError
 * with a `cause` chain in undici. We don't try to enumerate every undici
 * error — just bucket them as transient `network_error` so the agent retries
 * once (per playbook) before giving up.
 *
 * Returns null when the error doesn't match a known network shape — caller
 * falls back to the generic `tool_threw` code.
 */
export function networkErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === "AbortError") return "aborted";
  const msg = String(e.message ?? "");
  if (e.code === "ECONNREFUSED" || /econnrefused/i.test(msg)) return "network_error";
  if (e.code === "ECONNRESET" || /econnreset/i.test(msg)) return "network_error";
  if (e.code === "ETIMEDOUT" || /etimedout/i.test(msg)) return "network_error";
  if (e.code === "EAI_AGAIN" || /eai_again/i.test(msg)) return "network_error";
  if (e.code === "ENOTFOUND" || /enotfound|getaddrinfo/i.test(msg)) return "network_error";
  if (/fetch failed|undici/i.test(msg)) return "network_error";
  return null;
}

/**
 * Build a stable error envelope used by HTTP-touching tools (atlassian,
 * github, jira_align, fetch). Adds `code` + `status` alongside the existing
 * `error` + `url` fields so legacy callers (everything before PR-A) keep
 * working — the new fields are purely additive.
 */
export interface HttpToolError {
  error: string;
  code: string;
  status?: number;
  url?: string;
  /**
   * Server-supplied retry delay (ms) parsed from `Retry-After`. Present on
   * `http_429` responses when the upstream included the header.
   */
  retry_after_ms?: number;
}

/**
 * Classify a Node `fs` exception into a stable error code. The agent's
 * playbook reacts differently to file-not-found (re-check spelling) vs
 * permission-denied (don't retry, tell user) vs the credential denylist
 * (don't retry, explain refusal). Used by every files.ts catch block.
 *
 * Custom throws inside files.ts attach a `code` property directly via
 * `Object.assign(new Error(msg), {code})`; this helper picks that up first,
 * then falls back to the Node fs-syscall codes, then to a generic.
 */
export function classifyFsError(err: unknown): string {
  if (!err || typeof err !== "object") return "fs_error";
  const e = err as { code?: string; message?: string };
  // Caller-attached code (assertSafePath denylist refusals, custom throws).
  if (typeof e.code === "string") {
    if (e.code === "ENOENT") return "file_not_found";
    if (e.code === "EACCES" || e.code === "EPERM") return "permission_denied";
    if (e.code === "EISDIR") return "path_is_directory";
    if (e.code === "ENOTDIR") return "path_not_directory";
    if (e.code === "EEXIST") return "already_exists";
    return e.code; // already in our vocabulary (denylist, etc.)
  }
  return "fs_error";
}

/**
 * Parse a `Retry-After` header value into milliseconds. Accepts either an
 * integer-seconds string ("60") or an HTTP-date. Returns undefined on bad
 * input so the caller doesn't have to guard.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (!Number.isFinite(dateMs)) return undefined;
  const delta = dateMs - Date.now();
  return delta > 0 ? delta : 0;
}
