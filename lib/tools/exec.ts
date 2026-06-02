import { execSync } from "node:child_process";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import { getInjectedSubprocessEnv } from "@/lib/env/allowlist";
import { checkExecAllowed, resolveSafetyMode } from "./safety";

const MAX_OUTPUT_BYTES = 8_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

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

function clipOutput(text: string, max = MAX_OUTPUT_BYTES): { value: string; truncated: boolean } {
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
  },
): string {
  if (!command.trim()) {
    return JSON.stringify({ exit_code: 1, stderr: "command is required", code: "invalid_args" });
  }

  const timeout = Math.min(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const mode = resolveSafetyMode();
  const gate = checkExecAllowed(command, {
    mode,
    allowUnsafe: options.allow_unsafe,
    blockedByPattern: isBlockedCommand(command),
  });
  if (!gate.allowed) {
    return JSON.stringify({ exit_code: 126, stderr: gate.reason, safety_mode: mode, code: "denylist" });
  }

  const cwd = options.cwd?.trim() ? options.cwd : process.cwd();
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
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const clipped = clipOutput(output);
    return JSON.stringify({ exit_code: 0, stdout: clipped.value, truncated: clipped.truncated, cwd });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string; code?: string };
    const out = clipOutput(String(e.stdout ?? ""));
    const errText = clipOutput(String(e.stderr ?? e.message ?? ""), 2_000);
    // Distinguish the common spawn failures so the agent's playbook can
    // react. ENOENT means the binary isn't on PATH (don't retry — tell the
    // user); EACCES means non-executable / permissions (don't retry); a
    // killed-by-timeout SIGTERM means we exhausted timeout_ms (narrow the
    // command, don't retry as-is).
    const code = execErrorCode(e, errText.value);
    return JSON.stringify({
      exit_code: e.status ?? 1,
      stdout: out.value,
      stderr: errText.value,
      truncated: out.truncated || errText.truncated,
      cwd,
      code,
    });
  }
}

function execErrorCode(
  err: { code?: string; status?: number; message?: string },
  stderr: string,
): string {
  if (err.code === "ENOENT") return "command_not_found";
  if (err.code === "EACCES") return "permission_denied";
  if (err.code === "ETIMEDOUT" || /timed out|signal:\s*sigterm/i.test(stderr) || /timed out/i.test(err.message ?? "")) {
    return "tool_timeout";
  }
  // Non-zero exit is a normal command outcome (the agent reads stdout/stderr
  // to decide what to do). Surface as `command_failed` only when the spawn
  // itself errored with no exit status.
  if (err.status === undefined) return "command_failed";
  return "command_nonzero_exit";
}

const execSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory for command execution (defaults to process cwd)"),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables to inject for this command"),
  timeout_ms: z.number().optional().describe("Timeout in milliseconds (default 10000, max 60000)"),
  allow_unsafe: z.boolean().optional().describe("Set true to bypass safety blocking for risky commands"),
});

export const localExecTool = tool(
  async ({ command, cwd, env, timeout_ms, allow_unsafe }) =>
    runLocalCommand(command, { cwd, env, timeout_ms, allow_unsafe }),
  {
    name: "local_exec",
    description: "Run local shell commands with optional cwd/env overrides. Output is truncated to 8 KB.",
    schema: execSchema,
  },
);

export const shellExecTool = tool(
  async ({ command, cwd, env, timeout_ms, allow_unsafe }) =>
    runLocalCommand(command, { cwd, env, timeout_ms, allow_unsafe }),
  {
    name: "shell_exec",
    description: "Backward-compatible alias for local_exec.",
    schema: execSchema,
  },
);

registerTools("Shell", "execute", [localExecTool, shellExecTool]);
