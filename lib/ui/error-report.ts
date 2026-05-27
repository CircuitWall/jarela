"use client";
// Generalized user-facing error reporting. Wraps the toast pub/sub with an
// expand-to-details treatment plus a one-click "Report this issue" path that
// opens a pre-filled GitHub issue at the configured issue tracker. No
// outbound network from the app — the user reviews and submits the issue
// themselves, which keeps the no-telemetry stance intact.
//
// Forks set NEXT_PUBLIC_APP_ISSUE_URL to redirect "Report a bug" away from
// upstream (CircuitWall/jarela) and to their own tracker.

import { pushToast } from "./toasts";
import { getAppIssueUrl } from "@/lib/env/app-config";

// GitHub's "new issue" URL works up to ~8KB before some clients silently drop
// the body. Stay well under that and tell the user to copy the full report
// from clipboard if we have to truncate.
const MAX_ISSUE_BODY_BYTES = 7000;

export interface ErrorReportInput {
  // Short user-facing headline, e.g. "Couldn't toggle MCP server".
  title: string;
  // Optional plain-language one-liner under the title.
  summary?: string;
  // The original error. Accept anything — we'll stringify safely.
  error: unknown;
  // Free-form context echoed into the issue body. Keep keys short.
  // e.g. { panel: "scheduled-tasks", action: "task.toggle", task_id: "t_42" }
  context?: Record<string, unknown>;
}

export interface ReportEnv {
  appVersion: string;
  userAgent: string;
  url: string;
  ts: string;
}

// Pure: extract the most useful string representation of an unknown error.
// Prefer `Error.stack` (includes message + frames), fall back to message,
// fall back to String(). Never throws.
export function stringifyError(err: unknown): string {
  if (err == null) return "(no error provided)";
  if (err instanceof Error) {
    return err.stack ?? err.message ?? err.name ?? "Error";
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    // JSON.stringify can throw on circular refs.
    return String(err);
  }
}

function formatContext(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return "";
  const keys = Object.keys(ctx);
  if (keys.length === 0) return "";
  const lines = keys.map((k) => {
    const v = ctx[k];
    let rendered: string;
    if (v == null) rendered = String(v);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      rendered = String(v);
    } else {
      try { rendered = JSON.stringify(v); } catch { rendered = String(v); }
    }
    return `- ${k}: ${rendered}`;
  });
  return `**Context:**\n${lines.join("\n")}\n\n`;
}

// Pure: build the markdown body and the issue title.
export function formatReport(
  input: ErrorReportInput,
  env: ReportEnv,
): { title: string; body: string } {
  const summary = input.summary ?? input.title;
  const errStr = stringifyError(input.error);
  const ctxBlock = formatContext(input.context);
  const body =
    `**What failed:** ${summary}\n\n` +
    `**Error:**\n` +
    "```\n" +
    `${errStr}\n` +
    "```\n\n" +
    ctxBlock +
    `**Environment:**\n` +
    `- App version: ${env.appVersion}\n` +
    `- User agent: ${env.userAgent}\n` +
    `- URL: ${env.url}\n` +
    `- Timestamp: ${env.ts}\n\n` +
    `---\n` +
    `<!-- Anything else about what you were doing when this happened? -->\n`;
  return { title: input.title, body };
}

// Pure: GitHub issue URL with title+body+labels prefilled. If the body would
// push the URL past MAX_ISSUE_BODY_BYTES we truncate and add a footer line
// pointing the user at the clipboard copy.
export function buildIssueUrl(report: { title: string; body: string }): string {
  let body = report.body;
  if (Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) {
    const footer = "\n\n_(report truncated — paste the full version from your clipboard)_\n";
    const room = MAX_ISSUE_BODY_BYTES - Buffer.byteLength(footer, "utf8");
    // Truncate by characters then re-check bytes to land safely under the cap.
    let truncated = body.slice(0, Math.max(room, 0));
    while (Buffer.byteLength(truncated, "utf8") > room && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    body = truncated + footer;
  }
  const params = new URLSearchParams({
    title: report.title,
    body,
    labels: "user-report",
  });
  return `${getAppIssueUrl()}?${params.toString()}`;
}

// Cached app version. We fetch once on the first error, then reuse for the
// session. Failure to read the endpoint isn't a real problem — we just
// surface "unknown" rather than blocking the user from filing an issue.
let cachedVersion: string | null = null;
let inFlight: Promise<string> | null = null;

async function readAppVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/v1/update", { method: "GET" });
      if (!res.ok) return "unknown";
      const j = (await res.json()) as { version?: string };
      cachedVersion = j.version ?? "unknown";
      return cachedVersion;
    } catch {
      // Endpoint missing in tests, or offline first launch. Don't surface.
      return "unknown";
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function buildEnv(appVersion: string): ReportEnv {
  const ua =
    typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "unknown";
  const url =
    typeof window !== "undefined" && window.location
      ? window.location.pathname
      : "/";
  return {
    appVersion,
    userAgent: ua,
    url,
    ts: new Date().toISOString(),
  };
}

// Push a sticky error toast carrying the details + report payload. The
// Toaster reads `details` and `reportInput` and renders the expand chevron
// plus Copy / Report buttons. We don't await the version fetch — the
// initial render uses "unknown" and the next push gets the real value.
export function pushErrorToast(input: ErrorReportInput): string {
  const details = stringifyError(input.error);
  // Kick off (or reuse) the version fetch but don't block the toast.
  void readAppVersion();
  return pushToast({
    kind: "error",
    source: "system",
    sourceLabel: "Error",
    title: input.title,
    body: input.summary ?? "Click to expand for details",
    agent_id: null,
    thread_id: null,
    ttl: 0,
    details,
    reportInput: input,
  });
}

// Used by Toaster when the user clicks Copy or Report. Awaits the cached
// version (or the in-flight fetch) so the report is accurate.
export async function buildReport(
  input: ErrorReportInput,
): Promise<{ title: string; body: string; url: string }> {
  const appVersion = cachedVersion ?? (await readAppVersion());
  const env = buildEnv(appVersion);
  const report = formatReport(input, env);
  return { ...report, url: buildIssueUrl(report) };
}

// Test seam: reset the version cache.
export function _resetVersionCacheForTests(): void {
  cachedVersion = null;
  inFlight = null;
}
