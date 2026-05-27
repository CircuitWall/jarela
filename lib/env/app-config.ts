// Branding knobs sourced from NEXT_PUBLIC_* env vars so forks (e.g. vClaw)
// can rebrand the app without patching source. NEXT_PUBLIC_* is the right
// channel here because Next.js inlines these at build time, which lets
// client components read them directly (no React Context, no server
// round-trip). Server-only modules read the same keys at runtime.
//
// Keep this module client-safe — no Node-only imports, no DB/FS access.

const DEFAULT_APP_NAME = "Jarela";
const DEFAULT_APP_DESCRIPTION = "Jarela — local chat interface for LangGraph agents";
const DEFAULT_ISSUE_URL = "https://github.com/CircuitWall/jarela/issues/new";

export function getAppName(): string {
  return process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;
}

export function getAppDescription(): string {
  return process.env.NEXT_PUBLIC_APP_DESCRIPTION?.trim() || DEFAULT_APP_DESCRIPTION;
}

export function getAppIssueUrl(): string {
  return process.env.NEXT_PUBLIC_APP_ISSUE_URL?.trim() || DEFAULT_ISSUE_URL;
}
