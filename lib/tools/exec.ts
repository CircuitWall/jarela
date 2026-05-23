import { execSync } from "child_process";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";

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
    return JSON.stringify({ exit_code: 1, stderr: "command is required" });
  }

  const timeout = Math.min(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  if (!options.allow_unsafe && isBlockedCommand(command)) {
    return JSON.stringify({
      exit_code: 126,
      stderr: "Command blocked by safety policy. Pass allow_unsafe=true only when you fully trust the command.",
    });
  }

  const cwd = options.cwd?.trim() ? options.cwd : process.cwd();
  const env = { ...process.env, ...options.env };

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
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const out = clipOutput(String(e.stdout ?? ""));
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

registerTools("Shell", [localExecTool, shellExecTool]);
