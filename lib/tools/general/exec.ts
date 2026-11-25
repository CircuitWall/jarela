// local_exec — backward-compatible one-shot wrapper.
// Each call creates a throwaway terminal session, runs the command, and
// closes the session immediately. State does NOT persist between calls.
// For stateful or interactive work, use terminal.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerLangChainPackage } from "../packages/langchain-package";
import { checkExecAllowed, isBlockedExecCommand, resolveSafetyMode } from "../security/safety";
import { TerminalSession, type ExecResult } from "@/lib/terminal";
import { getConfig } from "@/lib/env/config";
import { currentWorkspace, reportToolOutput, type ToolConfig } from "../filesystem/workspace-context";
import { withStreamDefault } from "../support/tool-metadata";

function clip(text: string, max = getConfig().execMaxOutputBytes): { value: string; truncated: boolean } {
  if (text.length <= max) return { value: text, truncated: false };
  return { value: `${text.slice(0, max)}\n[output truncated]`, truncated: true };
}

function formatExecResult(result: ExecResult & { timeoutMs: number }): string {
  const stdout = clip(result.stdout);
  const stderr = clip(result.stderr, 2_000);
  if (result.timedOut) {
    return JSON.stringify({
      exit_code: 124, stdout: stdout.value, stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated, cwd: result.cwd,
      timed_out: true, timeout_ms: result.timeoutMs,
      error: `command timed out after ${Math.round(result.timeoutMs / 1000)}s. Try a narrower scope or a larger timeout_ms.`,
    });
  }
  return JSON.stringify({
    exit_code: result.exitCode, stdout: stdout.value, stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated, cwd: result.cwd,
  });
}

export interface LocalCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  allow_unsafe?: boolean;
  workspaceRoot?: string;
  /** Stream stdout/stderr as it arrives. Never changes the returned result. */
  onOutput?: (chunk: string) => void;
}

export type LocalCommandStart =
  | { ok: false; error: string; safety_mode: string }
  | { ok: true; session: TerminalSession; result: Promise<string> };

/**
 * Single place that applies the exec safety gate and builds a throwaway
 * session. `local_exec` waits on the result; background shell work keeps the
 * session handle so it can stream output and be stopped.
 */
export function beginLocalCommand(command: string, options: LocalCommandOptions): LocalCommandStart {
  if (!command.trim()) return { ok: false, error: "command is required", safety_mode: resolveSafetyMode() };

  const mode = resolveSafetyMode();
  const gate = checkExecAllowed(command, { mode, allowUnsafe: options.allow_unsafe, blockedByPattern: isBlockedExecCommand(command) });
  if (!gate.allowed) {
    return { ok: false, error: gate.reason ?? "command blocked by safety policy", safety_mode: mode };
  }

  const timeout = options.timeout_ms ?? 60_000;
  const session = new TerminalSession({
    sessionId: `exec:throwaway:${Date.now()}:${randomUUID().slice(0, 8)}`,
    cwd: options.cwd,
    env: options.env,
    workspaceRoot: options.workspaceRoot,
    onOutput: options.onOutput,
  });
  const result = session.exec(command, timeout)
    .then((r) => formatExecResult({ ...r, timeoutMs: timeout }))
    .finally(() => session.close());
  return { ok: true, session, result };
}

async function runLocalCommand(command: string, options: LocalCommandOptions): Promise<string> {
  const started = beginLocalCommand(command, options);
  if (!started.ok) return JSON.stringify({ exit_code: 126, stderr: started.error, safety_mode: started.safety_mode });
  return started.result;
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
    runLocalCommand(command, {
      cwd, env, timeout_ms, allow_unsafe,
      workspaceRoot: currentWorkspace(config)?.root,
      onOutput: (chunk) => reportToolOutput(config, "local_exec", chunk),
    }),
  {
    name: "local_exec",
    description: "Run a one-shot shell command in a throwaway session for builds, tests, git, package managers, and other commands that do not need persisted shell state. Output is truncated to 8 KB. Prefer file_glob/file_grep/file_read/file_edit/file_multi_edit for file discovery, inspection, and edits; prefer terminal for multi-step stateful or interactive work.",
    schema: execSchema,
  },
), true);

registerLangChainPackage({
  category: "Shell",
  tools: { execute: [localExecTool] },
});
