// local_exec and shell_exec — backward-compatible one-shot wrappers.
// Each call creates a throwaway terminal session, runs the command, and
// closes the session immediately. State does NOT persist between calls.
// For stateful multi-step work, use terminal_exec.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import { checkExecAllowed, resolveSafetyMode } from "./safety";
import { TerminalSession } from "@/lib/terminal";
import { getConfig } from "@/lib/env/config";
import { currentWorkspace, type ToolConfig } from "./workspace-context";
import { withStreamDefault } from "./tool-metadata";

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
];

function isBlockedCommand(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

function clip(text: string, max = getConfig().execMaxOutputBytes): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: `${text.slice(0, max)}\n[output truncated]`, truncated: true };
}

async function runLocalCommand(command: string, options: {
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  allow_unsafe?: boolean;
  workspaceRoot?: string;
}): Promise<string> {
  if (!command.trim()) return JSON.stringify({ exit_code: 1, stderr: "command is required" });

  const mode = resolveSafetyMode();
  const gate = checkExecAllowed(command, { mode, allowUnsafe: options.allow_unsafe, blockedByPattern: isBlockedCommand(command) });
  if (!gate.allowed) return JSON.stringify({ exit_code: 126, stderr: gate.reason, safety_mode: mode });

  const timeout = options.timeout_ms ?? 60_000;
  const session = new TerminalSession({
    sessionId: `exec:throwaway:${Date.now()}`,
    cwd: options.cwd,
    env: options.env,
    workspaceRoot: options.workspaceRoot,
  });

  try {
    const result = await session.exec(command, timeout);
    const stdout = clip(result.stdout);
    const stderr = clip(result.stderr, 2_000);

    if (result.timedOut) {
      return JSON.stringify({
        exit_code: 124, stdout: stdout.value, stderr: stderr.value,
        truncated: stdout.truncated || stderr.truncated, cwd: result.cwd,
        timed_out: true, timeout_ms: timeout,
        error: `command timed out after ${Math.round(timeout / 1000)}s. Try a narrower scope or a larger timeout_ms.`,
      });
    }

    return JSON.stringify({
      exit_code: result.exitCode, stdout: stdout.value, stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated, cwd: result.cwd,
    });
  } finally {
    session.close();
  }
}

const execSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory (defaults to process cwd)"),
  env: z.record(z.string(), z.string()).optional().describe("Extra environment variables for this command"),
  timeout_ms: z.number().optional().describe("Kill timeout in milliseconds (default 60000)"),
  allow_unsafe: z.boolean().optional().describe("Bypass safety blocking for risky commands"),
});

export const localExecTool = withStreamDefault(tool(
  async ({ command, cwd, env, timeout_ms, allow_unsafe }, config?: ToolConfig) =>
    runLocalCommand(command, { cwd, env, timeout_ms, allow_unsafe, workspaceRoot: currentWorkspace(config)?.root }),
  {
    name: "local_exec",
    description: "Run a one-shot shell command in a throwaway session for builds, tests, git, package managers, and other commands that do not need persisted shell state. Output is truncated to 8 KB. Prefer file_glob/file_grep/file_read/file_edit/file_multi_edit for file discovery, inspection, and edits; prefer terminal_exec for multi-step stateful or interactive work.",
    schema: execSchema,
  },
), true);

export const shellExecTool = withStreamDefault(tool(
  async ({ command, cwd, env, timeout_ms, allow_unsafe }, config?: ToolConfig) =>
    runLocalCommand(command, { cwd, env, timeout_ms, allow_unsafe, workspaceRoot: currentWorkspace(config)?.root }),
  {
    name: "shell_exec",
    description: "Backward-compatible alias for local_exec. Prefer local_exec in new plans so one-shot shell usage is explicit.",
    schema: execSchema,
  },
), true);

registerLangChainPackage({
  category: "Shell",
  tools: { execute: [localExecTool, shellExecTool] },
});
