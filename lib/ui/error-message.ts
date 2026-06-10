"use client";
// Centralized human-friendly error-title mapping. Used by pushErrorToast
// callers so the headline a user sees is consistent across the UI:
// "Not authorized" / "Server error" / "Network unreachable" / "Cancelled".
// The original error string still rides along as `details` for the expand
// chevron and the Report button. Unknown errors fall back to the
// caller-supplied label.

import { pushErrorToast } from "./error-report";

interface HttpLikeError {
  status?: number;
  code?: string | number;
  name?: string;
  message?: string;
}

function asHttpLike(err: unknown): HttpLikeError | null {
  if (err == null) return null;
  if (typeof err === "object") return err as HttpLikeError;
  return null;
}

function extractStatus(err: unknown): number | null {
  const h = asHttpLike(err);
  if (!h) return null;
  if (typeof h.status === "number") return h.status;
  // ApiError-style: status is the first 3-digit run in the message.
  const m = typeof h.message === "string" ? /\b([45]\d{2})\b/.exec(h.message) : null;
  if (m) return Number(m[1]);
  return null;
}

function isAbort(err: unknown): boolean {
  const h = asHttpLike(err);
  if (!h) return false;
  if (h.name === "AbortError") return true;
  if (h.code === "ABORT_ERR" || h.code === 20) return true;
  return false;
}

function isNetwork(err: unknown): boolean {
  const h = asHttpLike(err);
  if (!h) return false;
  const msg = typeof h.message === "string" ? h.message.toLowerCase() : "";
  if (/failed to fetch|networkerror|network request|econn|enotfound|etimedout|fetch failed/.test(msg)) {
    return true;
  }
  if (h.code === "ECONNREFUSED" || h.code === "ENOTFOUND" || h.code === "ETIMEDOUT") return true;
  return false;
}

/**
 * Map any error to a short, user-facing headline. Falls back to
 * `fallback` for shapes we don't recognise — the underlying error string
 * is still surfaced as toast details, so unknown errors aren't lost.
 */
export function friendlyErrorTitle(err: unknown, fallback: string): string {
  if (isAbort(err)) return "Cancelled";
  if (isNetwork(err)) return "Network unreachable";
  const status = extractStatus(err);
  if (status != null) {
    if (status === 401 || status === 403) return "Not authorized";
    if (status === 404) return "Not found";
    if (status === 408) return "Request timed out";
    if (status === 409) return "Conflict";
    if (status === 413) return "Too large";
    if (status === 422) return "Invalid input";
    if (status === 423) return "Locked";
    if (status === 429) return "Too many requests";
    if (status >= 500 && status <= 504) return "Server error";
    if (status >= 400 && status < 500) return "Request rejected";
  }
  return fallback;
}

/**
 * One-call error-to-toast helper. Always shows a friendly headline; the
 * raw error stays in details. Provide `fallbackTitle` for the unknown-
 * error branch. `context` is echoed into the Report-an-Issue body.
 */
export function reportError(input: {
  error: unknown;
  fallbackTitle: string;
  summary?: string;
  context?: Record<string, unknown>;
}): void {
  pushErrorToast({
    title: friendlyErrorTitle(input.error, input.fallbackTitle),
    summary: input.summary,
    error: input.error,
    context: input.context,
  });
}
