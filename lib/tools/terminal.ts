import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { TerminalSession, getSession, putSession, removeSession, listSessions, sessionCount, evictIdleSessions } from "@/lib/terminal";
import { registerLangChainPackage } from "./langchain-package";
import { checkExecAllowed, resolveSafetyMode, type SafetyMode } from "./safety";
import { getConfig } from "@/lib/env/config";
import type { ToolConfig } from "./workspace-context";
import { currentWorkspace } from "./workspace-context";
import { withStreamDefault } from "./tool-metadata";

// Evict idle sessions every 60 s. .unref() so this timer doesn't keep Node alive.
setInterval(() => evictIdleSessions(getConfig().terminalIdleTtlMs), 60_000).unref();

const DEFAULT_SHELL = platform() === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
];

function isBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

function checkCommand(command: string, allowUnsafe: boolean | undefined, mode: SafetyMode): string | null {
  const gate = checkExecAllowed(command, { mode, allowUnsafe, blockedByPattern: isBlocked(command) });
  return gate.allowed ? null : (gate.reason ?? "command blocked by safety policy");
}

function implicitSessionId(config?: ToolConfig): string {
  const tid = config?.configurable?.thread_id;
  return `thread:${typeof tid === "string" && tid ? tid : "_default"}`;
}

function getOrCreateSession(sessionId: string, opts: { cwd?: string; env?: Record<string, string>; shell?: string; workspaceRoot?: string }): TerminalSession {
  const existing = getSession(sessionId);
  if (existing) return existing;

  const maxSessions = getConfig().terminalMaxSessions;
  if (sessionCount() >= maxSessions) {
    throw new Error(`Max concurrent terminal sessions (${maxSessions}) reached. Close an existing session first.`);
  }

  const session = new TerminalSession({ ...opts, sessionId });
  putSession(session);
  return session;
}

// ── terminal_open ─────────────────────────────────────────────────────────────

export const terminalOpenTool = tool(
  async ({ session_id, shell, cwd, env }, config?: ToolConfig) => {
    const sid = session_id ?? randomUUID();
    const workspaceRoot = currentWorkspace(config)?.root;
    try {
      const session = getOrCreateSession(sid, { shell: shell ?? DEFAULT_SHELL, cwd, env: env as Record<string, string> | undefined, workspaceRoot });
      return JSON.stringify({ session_id: session.sessionId, shell: session.shell, pid: session.pid });
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }
  },
  {
    name: "terminal_open",
    description: "Open a persistent shell session. Returns a session_id to use with terminal_exec / terminal_send. Omit session_id to get a fresh one. Sessions persist across agent turns.",
    schema: z.object({
      session_id: z.string().optional().describe("Reuse an existing session, or omit to create a new one"),
      shell: z.string().optional().describe("Shell executable (default: $SHELL on Unix, powershell.exe on Windows)"),
      cwd: z.string().optional().describe("Starting working directory"),
      env: z.record(z.string(), z.string()).optional().describe("Additional env vars for this session"),
    }),
  },
);

// ── terminal_exec ─────────────────────────────────────────────────────────────

export const terminalExecTool = withStreamDefault(tool(
  async ({ session_id, command, timeout_ms, allow_unsafe }, config?: ToolConfig) => {
    const mode = resolveSafetyMode();
    const deny = checkCommand(command, allow_unsafe, mode);
    if (deny) return JSON.stringify({ exit_code: 126, stderr: deny, safety_mode: mode });

    const sid = session_id ?? implicitSessionId(config);
    const workspaceRoot = currentWorkspace(config)?.root;

    let session: TerminalSession;
    try {
      session = getOrCreateSession(sid, { workspaceRoot });
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }

    const result = await session.exec(command, timeout_ms ?? 60_000);

    if (result.timedOut) {
      return JSON.stringify({
        exit_code: 124,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: true,
        session_id: sid,
        cwd: result.cwd,
        error: `command timed out after ${Math.round((timeout_ms ?? 60_000) / 1000)}s`,
      });
    }

    return JSON.stringify({
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      session_id: sid,
      cwd: result.cwd,
    });
  },
  {
    name: "terminal_exec",
    description:
      "Run a command in a persistent shell session. State (cwd, env exports, shell variables) persists between calls. Omit session_id to use the implicit per-thread session.",
    schema: z.object({
      command: z.string().describe("Shell command to run"),
      session_id: z.string().optional().describe("Session from terminal_open, or omit for the implicit per-thread session"),
      timeout_ms: z.number().optional().describe("Kill timeout in ms (default 60000)"),
      allow_unsafe: z.boolean().optional().describe("Bypass safety block for a single call"),
    }),
  },
), true);

// ── terminal_send ─────────────────────────────────────────────────────────────

export const terminalSendTool = tool(
  async ({ session_id, input, wait_ms }, config?: ToolConfig) => {
    const sid = session_id ?? implicitSessionId(config);
    const session = getSession(sid);
    if (!session) return JSON.stringify({ error: `No active session "${sid}"` });

    try {
      session.send(input);
    } catch (err) {
      return JSON.stringify({ error: String(err) });
    }

    if (wait_ms && wait_ms > 0) {
      await new Promise((r) => setTimeout(r, wait_ms));
    }

    return JSON.stringify({ output: session.readBuffer() });
  },
  {
    name: "terminal_send",
    description:
      "Send raw bytes to an interactive process's stdin (e.g. answer a REPL prompt, send Ctrl-C via '\\x03'). Returns buffered stdout after wait_ms.",
    schema: z.object({
      input: z.string().describe("Raw input to send to stdin"),
      session_id: z.string().optional().describe("Session id (default: implicit per-thread session)"),
      wait_ms: z.number().optional().describe("Milliseconds to wait for output before returning (default 0)"),
    }),
  },
);

// ── terminal_read ─────────────────────────────────────────────────────────────

export const terminalReadTool = tool(
  async ({ session_id, clear, wait_ms }, config?: ToolConfig) => {
    const sid = session_id ?? implicitSessionId(config);
    const session = getSession(sid);
    if (!session) return JSON.stringify({ error: `No active session "${sid}"` });

    if (wait_ms && wait_ms > 0) {
      await new Promise((r) => setTimeout(r, wait_ms));
    }

    return JSON.stringify({ output: session.readBuffer(clear ?? false), session_id: sid });
  },
  {
    name: "terminal_read",
    description: "Read buffered stdout from a terminal session without sending a command. Useful to check what a background process has printed.",
    schema: z.object({
      session_id: z.string().optional().describe("Session id (default: implicit per-thread session)"),
      clear: z.boolean().optional().describe("Clear the buffer after reading (default false)"),
      wait_ms: z.number().optional().describe("Wait this many ms before reading (default 0)"),
    }),
  },
);

// ── terminal_close ────────────────────────────────────────────────────────────

export const terminalCloseTool = tool(
  async ({ session_id }, config?: ToolConfig) => {
    const sid = session_id ?? implicitSessionId(config);
    removeSession(sid);
    return JSON.stringify({ ok: true, session_id: sid });
  },
  {
    name: "terminal_close",
    description: "Kill a terminal session and free its resources. The implicit per-thread session is closed if no session_id is given.",
    schema: z.object({
      session_id: z.string().optional().describe("Session to close (default: implicit per-thread session)"),
    }),
  },
);

// ── terminal_list ─────────────────────────────────────────────────────────────

export const terminalListTool = tool(
  async () => JSON.stringify(listSessions()),
  {
    name: "terminal_list",
    description: "List all open terminal sessions with their shell, idle time, and PID.",
    schema: z.object({}),
  },
);

registerLangChainPackage({
  category: "Shell",
  tools: {
    execute: [terminalOpenTool, terminalExecTool, terminalSendTool, terminalReadTool, terminalCloseTool, terminalListTool],
  },
});
