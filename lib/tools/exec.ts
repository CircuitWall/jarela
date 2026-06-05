import { execSync } from "node:child_process";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";
import { checkExecAllowed, resolveSafetyMode } from "./safety";
import { getConfig } from "@/lib/env/config";
import { currentWorkspace, type ToolConfig } from "./workspace-context";

// JARELA_EXEC_MAX_OUTPUT_BYTES overrides the output cap.
function maxOutputBytes(): number { return getConfig().execMaxOutputBytes; }
// Internal subprocess timeout. The agent's wall-clock budget on the tool
// call (see lib/tools/wallclock.ts) is the primary deadline; this kills
// the child process so a runaway shell can't keep burning CPU after the
// wallclock abandons the promise.
const EXEC_DEFAULT_TIMEOUT_MS = 60_000;

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
];

function isBlockedCommand(command: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

function clipOutput(text: string, max = maxOutputBytes()): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: `${text.slice(0, max)}\n[output truncated]`, truncated: true };
}

function runLocalCommand(
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout_ms?: number;
    allow_unsafe?: boolean;
    workspaceRoot?: string;
  },
): string {
  if (!command.trim()) {
    return JSON.stringify({ exit_code: 1, stderr: "command is required" });
  }

  const timeout = options.timeout_ms ?? EXEC_DEFAULT_TIMEOUT_MS;

  const mode = resolveSafetyMode();
  const gate = checkExecAllowed(command, {
    mode,
    allowUnsafe: options.allow_unsafe,
    blockedByPattern: isBlockedCommand(command),
  });
  if (!gate.allowed) {
    return JSON.stringify({ exit_code: 126, stderr: gate.reason, safety_mode: mode });
  }

  // Precedence: explicit options.cwd > active workspace root > process.cwd().
  // The workspace root takes priority over process.cwd() so the agent
  // doesn't have to thread `cwd` into every shell call once it's called
  // workspace_init.
  const cwd = options.cwd?.trim()
    ? options.cwd
    : options.workspaceRoot ?? process.cwd();
  // Layered env. Later spreads win:
  //   1. process.env — PATH, HOME, locale, the shell's exports
  //   2. integration-store credentials — so a service install (launchd,
  //      systemd) where ANTHROPIC_API_KEY etc. were never exported in the
  //      service's environment still hands those values to subprocesses.
  //      The encrypted store, populated by env-sync from the user's rc
  //      or via the Integrations panel, is the canonical source.
  //   3. options.env — explicit per-call override always wins.
  const env = { ...process.env, ...getInjectedSubprocessEnv(), ...options.env };

  try {
    const output = execSync(command, {
      cwd,
      env,
      timeout,
      encoding: "utf8",
      maxBuffer: maxOutputBytes() * 2,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const clipped = clipOutput(output);
    return JSON.stringify({ exit_code: 0, stdout: clipped.value, truncated: clipped.truncated, cwd });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string; signal?: string; code?: string; killed?: boolean };
    const out = clipOutput(String(e.stdout ?? ""));
    // Node's execSync surfaces a `timeout` kill as `signal: "SIGTERM"`
    // and/or `killed: true` with no exit status. Bare exit_code=1 +
    // empty stderr would lead the agent to retry the same command;
    // call out the timeout explicitly so it narrows scope or raises
    // timeout_ms instead.
    const timedOut = e.code === "ETIMEDOUT"
      || e.signal === "SIGTERM"
      || (e.killed === true && (e.status == null || e.status === 0));
    if (timedOut) {
      const errText = clipOutput(String(e.stderr ?? ""), 2_000);
      return JSON.stringify({
        exit_code: 124,
        stdout: out.value,
        stderr: errText.value,
        truncated: out.truncated || errText.truncated,
        cwd,
        timed_out: true,
        timeout_ms: timeout,
        error: `command timed out after ${Math.round(timeout / 1000)}s. Try a narrower scope, a smaller working set, or pass a larger timeout_ms.`,
      });
    }
    const errText = clipOutput(String(e.stderr ?? e.message ?? ""), 2_000);
    return JSON.stringify({
      exit_code: e.status ?? 1,
      stdout: out.value,
      stderr: errText.value,
      truncated: out.truncated || errText.truncated,
      cwd,
    });
  }
}

const execSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory for command execution (defaults to process cwd)"),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables to inject for this command"),
  timeout_ms: z.number().optional().describe("Subprocess kill timeout in milliseconds (default 60000). Independent of the agent's wall-clock budget on this call."),
  allow_unsafe: z.boolean().optional().describe("Set true to bypass safety blocking for risky commands"),
});

export const localExecTool = tool(
  async ({ command, cwd, env, timeout_ms, allow_unsafe }, config?: ToolConfig) =>
    runLocalCommand(command, { cwd, env, timeout_ms, allow_unsafe, workspaceRoot: currentWorkspace(config)?.root }),
  {
    name: "local_exec",
    description: "Run local shell commands with optional cwd/env overrides. Output is truncated to 8 KB.",
    schema: execSchema,
  },
);

export const shellExecTool = tool(
  async ({ command, cwd, env, timeout_ms, allow_unsafe }, config?: ToolConfig) =>
    runLocalCommand(command, { cwd, env, timeout_ms, allow_unsafe, workspaceRoot: currentWorkspace(config)?.root }),
  {
    name: "shell_exec",
    description: "Backward-compatible alias for local_exec.",
    schema: execSchema,
  },
);

registerTools("Shell", "execute", [localExecTool, shellExecTool]);
