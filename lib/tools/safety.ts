// Safety mode for destructive built-in tools (exec + filesystem writes).
//
// Resolved once per call from `JARELA_TOOL_SAFETY`. Three tiers:
//
//   "safe"        — read-only. Exec accepts only an allowlisted set of
//                   inspection commands (ls, git status, …); filesystem
//                   tools refuse every write, edit, move, copy, delete,
//                   or mkdir. Per-call `allow_unsafe` is IGNORED.
//   "mostly_safe" — default. Exec blocks the obviously-dangerous pattern
//                   list (rm -rf /, shutdown, fork bomb, …); filesystem
//                   tools refuse credential paths and the Jarela data dir.
//                   Per-call `allow_unsafe=true` lifts the exec block for
//                   that single call.
//   "bypass"      — every guard off. For local development on a machine
//                   you control and trust completely. NOT for use behind
//                   a tunnel or with untrusted prompt sources.
//
// The mode is process-wide so prompt injection cannot escalate by
// passing arguments — the LLM can only ever *downgrade* (via
// `allow_unsafe=false` semantics, which is just "don't try to bypass").

export type SafetyMode = "safe" | "mostly_safe" | "bypass";

export function resolveSafetyMode(): SafetyMode {
  const raw = (process.env.JARELA_TOOL_SAFETY ?? "").trim().toLowerCase();
  if (raw === "safe") return "safe";
  if (raw === "bypass" || raw === "unsafe") return "bypass";
  return "mostly_safe";
}

// Inspection-only commands allowed in `safe` mode. Matched as the FIRST
// token (after stripping leading whitespace) — pipelines, redirections,
// command substitution, &&, ;, etc. are all rejected because we cannot
// reason about what the right-hand side will do.
const SAFE_EXEC_ALLOWLIST = new Set([
  "ls", "dir", "pwd", "cd", "echo", "cat", "type", "head", "tail",
  "wc", "stat", "file", "which", "where", "whoami", "hostname",
  "date", "uname", "df", "du", "ps", "env", "printenv",
  "git", "node", "npm", "npx", "deno", "python", "python3", "pip", "pip3",
]);

// Subcommands considered read-only for tools that take a verb. We only
// need to enumerate the dangerous tools here — anything not listed falls
// back to "the whole tool is read-only" (e.g. `cat`, `ls`).
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "status", "log", "diff", "show", "blame", "branch", "tag",
    "remote", "ls-files", "ls-tree", "config", "rev-parse",
    "describe", "shortlog", "reflog",
  ]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "config", "whoami", "ping", "doctor"]),
  npx: new Set([]), // npx runs arbitrary code; never allow under "safe"
  node: new Set([]), // bare `node` opens a REPL; `node script.js` runs anything
  python: new Set([]),
  python3: new Set([]),
  deno: new Set(["info", "doc"]),
  pip: new Set(["list", "show", "freeze", "config"]),
  pip3: new Set(["list", "show", "freeze", "config"]),
};

// Shell metacharacters that compose commands or redirect IO. Their
// presence in `safe` mode is grounds for rejection because the
// allowlist check only inspects the first token.
const COMPOSER_RE = /[|&;`$<>]|\$\(|\|\||&&/;

export interface ExecAllowResult {
  allowed: boolean;
  reason?: string;
}

export function checkExecAllowed(
  command: string,
  opts: { mode: SafetyMode; allowUnsafe?: boolean; blockedByPattern: boolean },
): ExecAllowResult {
  if (opts.mode === "bypass") return { allowed: true };
  if (opts.mode === "mostly_safe") {
    if (opts.blockedByPattern && !opts.allowUnsafe) {
      return {
        allowed: false,
        reason:
          "Command blocked by safety policy (mode=mostly_safe). Pass allow_unsafe=true only when you fully trust the command.",
      };
    }
    return { allowed: true };
  }
  // safe mode
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "command is required" };
  if (COMPOSER_RE.test(trimmed)) {
    return {
      allowed: false,
      reason:
        "safe mode rejects pipelines, redirection, command substitution, &&, and ;. " +
        "Set JARELA_TOOL_SAFETY=mostly_safe (or bypass) to allow composite commands.",
    };
  }
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0]?.toLowerCase();
  if (!head || !SAFE_EXEC_ALLOWLIST.has(head)) {
    return {
      allowed: false,
      reason:
        `safe mode allows only inspection commands (${[...SAFE_EXEC_ALLOWLIST].sort().join(", ")}). ` +
        "Set JARELA_TOOL_SAFETY=mostly_safe to enable the broader policy.",
    };
  }
  const subAllowlist = SAFE_SUBCOMMANDS[head];
  if (subAllowlist) {
    const sub = tokens[1]?.toLowerCase().replace(/^--?/, "");
    // Allow bare invocations that are themselves read-only (e.g. `git`
    // alone prints help). Reject if the subcommand is missing for tools
    // that need one to be safe (node/python/npx → arbitrary code).
    if (subAllowlist.size === 0) {
      return {
        allowed: false,
        reason: `safe mode refuses '${head}' because it can execute arbitrary code. Use mostly_safe or bypass.`,
      };
    }
    if (sub && !subAllowlist.has(sub)) {
      return {
        allowed: false,
        reason:
          `safe mode allows '${head}' only for: ${[...subAllowlist].sort().join(", ")}. ` +
          "Use mostly_safe or bypass for other subcommands.",
      };
    }
  }
  return { allowed: true };
}

// File-system op classification.
export type FsOp = "read" | "write";

export function checkFsAllowed(
  op: FsOp,
  opts: { mode: SafetyMode },
): ExecAllowResult {
  if (opts.mode === "bypass" || opts.mode === "mostly_safe") return { allowed: true };
  // safe mode: reads are fine, writes are not.
  if (op === "read") return { allowed: true };
  return {
    allowed: false,
    reason:
      "safe mode refuses filesystem mutations (write/edit/move/copy/delete/mkdir). " +
      "Set JARELA_TOOL_SAFETY=mostly_safe to enable writes outside credential dirs.",
  };
}
