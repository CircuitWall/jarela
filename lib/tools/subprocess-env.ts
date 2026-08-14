// Shared subprocess environment resolver for exec and terminal tools.
//
// Problem: when Jarela runs as a launchd/systemd service it inherits a
// minimal PATH (/usr/bin:/bin etc.), not the user's interactive shell PATH
// (/opt/homebrew/bin, ~/.local/bin, nvm shims, etc.). Subprocesses then
// can't find tools the user expects (brew, node, python, git from nix, …).
//
// Fix: probe the user's interactive shell once at module init, merge its
// PATH into every subprocess env. Both exec and terminal import
// resolveSubprocessEnv from here so they share one code path.

import { spawnSync } from "node:child_process";
import { platform, homedir } from "node:os";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";

// Cached user-shell PATH — resolved once, reused for every subprocess.
let resolvedUserPath: string | null = null;
let pathProbed = false;

// Full shell-env snapshot (every var the user's interactive shell exports,
// not just PATH). Empty until the first successful env-sync (boot or the
// "Sync from environment" button) — see lib/env/sync.ts, which calls
// setFullShellEnv() after probing with lib/env/discover.ts's
// discoverAllShellEnv(). Restarting Jarela re-runs the boot-time sync and
// refreshes this from scratch.
let fullShellEnv: Record<string, string> = {};

/** Replace the cached full shell-env snapshot. Called by lib/env/sync.ts. */
export function setFullShellEnv(vars: Record<string, string>): void {
  fullShellEnv = vars;
}

/** Read the cached full shell-env snapshot (for tests / diagnostics). */
export function getFullShellEnv(): Record<string, string> {
  return fullShellEnv;
}

/** Probe the user's interactive shell PATH. Falls back to process.env.PATH silently. */
function getUserShellPath(): string {
  if (pathProbed) return resolvedUserPath ?? process.env.PATH ?? "";
  pathProbed = true;

  if (platform() === "win32") {
    // On Windows, PATH is in the User/Machine registry and already
    // inherited by the process. No extra probing needed.
    resolvedUserPath = process.env.PATH ?? "";
    return resolvedUserPath;
  }

  const shell = process.env.SHELL || "/bin/sh";
  try {
    // -i = interactive shell (sources ~/.zshrc / ~/.bashrc / equivalent)
    // timeout keeps a hung shell from stalling the first tool call.
    const result = spawnSync(shell, ["-ic", "echo $PATH"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: homedir(), TERM: "dumb" },
    });
    if (result.error) throw result.error;
    const out = (result.stdout ?? "").trim();
    // Pick the last non-empty line (login shells can print banner text first)
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const pathLine = lines[lines.length - 1] ?? "";
    if (pathLine.includes("/")) {
      resolvedUserPath = pathLine;
      return pathLine;
    }
  } catch {
    // Probe failed — fall through to process.env.PATH
  }

  resolvedUserPath = process.env.PATH ?? "";
  return resolvedUserPath;
}

/** Merge user-shell PATH with the process PATH, deduplicating segments. */
function buildMergedPath(): string {
  const loginPath = getUserShellPath();
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
 * Resolve cwd + env for a subprocess. Merges the full shell-env snapshot,
 * user-shell PATH, injected credentials, and any caller-supplied overrides
 * (highest priority). The shell-env snapshot matters for tools like
 * claude_delegate, whose spawned `claude` CLI may itself shell out to other
 * CLIs (gh, aws, jira, …) that read credentials straight from the
 * environment — those only exist in the user's rc files, not in Jarela's
 * own process.env when it runs as a background service.
 *
 * Precedence (low → high):
 *   process.env < full shell-env snapshot < user-shell PATH < getInjectedSubprocessEnv() < options.env
 *
 * cwd precedence: options.cwd > workspaceRoot > process.cwd()
 */
export function resolveSubprocessEnv(options: SubprocessEnvOptions): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = options.cwd?.trim() ? options.cwd : options.workspaceRoot ?? process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...fullShellEnv,
    PATH: buildMergedPath(),
    ...getInjectedSubprocessEnv(),
    ...options.env,
  };
  return { cwd, env };
}
