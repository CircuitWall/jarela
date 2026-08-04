// Shared subprocess environment resolver for exec and terminal tools.
//
// Problem: when Jarela runs as a launchd/systemd service it inherits a
// minimal PATH (/usr/bin:/bin etc.), not the user's interactive shell PATH
// (/opt/homebrew/bin, ~/.local/bin, nvm shims, etc.). Subprocesses then
// can't find tools the user expects (brew, node, python, git from nix, …).
//
// Fix: probe the login shell once at module init, merge its PATH into
// every subprocess env. Both exec and terminal import resolveSubprocessEnv
// from here so they share one code path.

import { execSync } from "node:child_process";
import { platform, homedir } from "node:os";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";

// Cached login-shell PATH — resolved once, reused for every subprocess.
let resolvedLoginPath: string | null = null;
let pathProbed = false;

/** Probe the user's login shell PATH. Falls back to process.env.PATH silently. */
function getLoginShellPath(): string {
  if (pathProbed) return resolvedLoginPath ?? process.env.PATH ?? "";
  pathProbed = true;

  if (platform() === "win32") {
    // On Windows, PATH is in the User/Machine registry and already
    // inherited by the process. No extra probing needed.
    resolvedLoginPath = process.env.PATH ?? "";
    return resolvedLoginPath;
  }

  const shell = process.env.SHELL || "/bin/sh";
  try {
    // -l = login shell (sources /etc/profile, ~/.profile, ~/.zprofile, etc.)
    // timeout keeps a hung shell from stalling the first tool call.
    const out = execSync(`${shell} -lc 'echo $PATH'`, {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: homedir(), TERM: "dumb" },
    }).trim();
    // Pick the last non-empty line (login shells can print banner text first)
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const pathLine = lines[lines.length - 1] ?? "";
    if (pathLine.includes("/")) {
      resolvedLoginPath = pathLine;
      return pathLine;
    }
  } catch {
    // Probe failed — fall through to process.env.PATH
  }

  resolvedLoginPath = process.env.PATH ?? "";
  return resolvedLoginPath;
}

/** Merge login-shell PATH with the process PATH, deduplicating segments. */
function buildMergedPath(): string {
  const loginPath = getLoginShellPath();
  const processPath = process.env.PATH ?? "";
  if (!loginPath || loginPath === processPath) return processPath;
  const seen = new Set<string>();
  const merged: string[] = [];
  const sep = platform() === "win32" ? ";" : ":";
  for (const seg of [...loginPath.split(sep), ...processPath.split(sep)]) {
    if (seg && !seen.has(seg)) { seen.add(seg); merged.push(seg); }
  }
  return merged.join(sep);
}

export interface SubprocessEnvOptions {
  cwd?: string;
  env?: Record<string, string>;
  workspaceRoot?: string;
}

/**
 * Resolve cwd + env for a subprocess. Merges login-shell PATH, injected
 * credentials, and any caller-supplied overrides (highest priority).
 *
 * Precedence (low → high):
 *   process.env < login-shell PATH < getInjectedSubprocessEnv() < options.env
 *
 * cwd precedence: options.cwd > workspaceRoot > process.cwd()
 */
export function resolveSubprocessEnv(options: SubprocessEnvOptions): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = options.cwd?.trim() ? options.cwd : options.workspaceRoot ?? process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: buildMergedPath(),
    ...getInjectedSubprocessEnv(),
    ...options.env,
  };
  return { cwd, env };
}
