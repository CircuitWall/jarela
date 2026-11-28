// `agent_session` — provider-neutral, multi-turn programmatic sessions for
// Claude Code, Codex, and GitHub Copilot (ADR-0137).
//
// The provider SDK is optional (ADR-0122): a missing package returns a
// structured DEPENDENCY_MISSING result and the existing *_delegate tools
// remain available. Sessions are in-memory, thread-scoped, and explicitly
// closed; no new persistence schema is introduced.

import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { isRuntimePackageInstalled } from "@/lib/dependencies/runtime-package";
import { resolveSafetyMode } from "../security/safety";
import { registerLangChainPackage } from "../packages/langchain-package";
import { currentWorkspace, reportToolProgress, type ToolConfig } from "../filesystem/workspace-context";
import { createClaudeAgentSession } from "./claude-agent-session";
import { createCodexAgentSession } from "./codex-agent-session";
import { createCopilotAgentSession } from "./copilot-agent-session";
import {
  AGENT_SESSION_MAX_SESSIONS,
  AGENT_SESSION_MAX_STEPS,
  AGENT_SESSION_PROVIDERS,
  type AgentSessionAdapter,
  type AgentSessionAdapterFactory,
  type AgentSessionApprovals,
  type AgentSessionCreateOptions,
  type AgentSessionProvider,
  type AgentSessionRecord,
  type AgentSessionTurnResult,
} from "./agent-session-types";

const PROVIDER_PACKAGE: Record<AgentSessionProvider, string> = {
  claude: "@anthropic-ai/claude-agent-sdk",
  codex: "@openai/codex-sdk",
  copilot: "@microsoft/copilot-sdk",
};

const DEFAULT_FACTORIES: Record<AgentSessionProvider, AgentSessionAdapterFactory> = {
  claude: createClaudeAgentSession,
  codex: createCodexAgentSession,
  copilot: createCopilotAgentSession,
};

interface SessionEntry extends AgentSessionRecord {
  adapter: AgentSessionAdapter | null;
  chain: Promise<void>;
}

const SESSIONS_SYM: unique symbol = Symbol.for("@jarela/agent-sessions");
type GlobalWithSessions = typeof globalThis & { [SESSIONS_SYM]?: Map<string, SessionEntry> };

function registry(): Map<string, SessionEntry> {
  const g = globalThis as GlobalWithSessions;
  if (!g[SESSIONS_SYM]) g[SESSIONS_SYM] = new Map();
  return g[SESSIONS_SYM];
}

let factoryOverride: AgentSessionAdapterFactory | null = null;

/** @internal — test seam; the override applies to every provider. */
export function _setAgentSessionAdapterFactoryForTests(factory: AgentSessionAdapterFactory | null): void {
  factoryOverride = factory;
}

function threadId(config?: ToolConfig): string | undefined {
  const id = config?.configurable?.thread_id;
  return typeof id === "string" && id ? id : undefined;
}

function sessionFor(id: string, config?: ToolConfig): SessionEntry | null {
  const entry = registry().get(id);
  if (!entry) return null;
  const owner = entry.ownerThreadId;
  const caller = threadId(config);
  if (owner && caller && owner !== caller) return null;
  return entry;
}

function activeCount(): number {
  let count = 0;
  for (const entry of registry().values()) {
    if (entry.state === "running" || entry.state === "ready") count += 1;
  }
  return count;
}

function appendSteps(entry: SessionEntry, steps: readonly string[]): void {
  entry.steps.push(...steps);
  if (entry.steps.length > AGENT_SESSION_MAX_STEPS) {
    entry.steps.splice(0, entry.steps.length - AGENT_SESSION_MAX_STEPS);
  }
}

function applyResult(entry: SessionEntry, result: AgentSessionTurnResult): void {
  appendSteps(entry, result.steps);
  entry.result = result.text || entry.result;
  if (result.providerSessionId) entry.providerSessionId = result.providerSessionId;
  entry.approvals = result.approvals;
  entry.state = "ready";
  entry.error = null;
  entry.updatedAt = Date.now();
}

function output(entry: SessionEntry): Record<string, unknown> {
  return {
    ok: true,
    session_id: entry.id,
    provider: entry.provider,
    state: entry.state,
    provider_session_id: entry.providerSessionId,
    cwd: entry.cwd,
    model: entry.model ?? null,
    result: entry.result,
    steps: entry.steps.slice(-50),
    approvals: entry.approvals,
    created_at: new Date(entry.createdAt).toISOString(),
    updated_at: new Date(entry.updatedAt).toISOString(),
  };
}

function failure(code: string, error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, code, error, ...extra });
}

function missingPackage(provider: AgentSessionProvider): string {
  const packageName = PROVIDER_PACKAGE[provider];
  return failure("DEPENDENCY_MISSING", `${provider} agent sessions need the "${packageName}" package, which is not installed.`, {
    provider,
    package: packageName,
    install_target: `runtime:${packageName}`,
    hint: "Install it from Settings → Tools → Packages, then retry. The existing *_delegate tools remain available.",
  });
}

export interface StartAgentSessionInput {
  provider: AgentSessionProvider;
  task: string;
  cwd?: string;
  model?: string;
}

export async function startAgentSession(
  input: StartAgentSessionInput,
  config?: ToolConfig,
): Promise<string> {
  const safetyMode = resolveSafetyMode();
  if (safetyMode === "safe") {
    return failure("SAFETY_BLOCKED", "agent_session requires JARELA_TOOL_SAFETY to be at least 'mostly_safe'.", {
      safety_mode: safetyMode,
    });
  }
  const cwd = input.cwd?.trim() || currentWorkspace(config)?.root;
  if (!cwd) {
    return failure("WORKSPACE_REQUIRED", "agent_session needs a project workspace. Call workspace_init first or pass cwd explicitly.");
  }
  if (activeCount() >= AGENT_SESSION_MAX_SESSIONS) {
    return failure("SESSION_LIMIT", `At most ${AGENT_SESSION_MAX_SESSIONS} agent sessions can be active. Close one first.`);
  }
  if (!isRuntimePackageInstalled(PROVIDER_PACKAGE[input.provider])) {
    return missingPackage(input.provider);
  }

  const entry: SessionEntry = {
    id: `agent_${randomUUID()}`,
    provider: input.provider,
    state: "running",
    cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(threadId(config) ? { ownerThreadId: threadId(config) } : {}),
    providerSessionId: null,
    steps: [],
    result: null,
    error: null,
    approvals: { approved: 0, denied: 0, mode: input.provider === "claude" ? "can-use-tool" : input.provider === "copilot" ? "runtime" : "sandbox" } satisfies AgentSessionApprovals,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    adapter: null,
    chain: Promise.resolve(),
  };

  try {
    const create = factoryOverride ?? DEFAULT_FACTORIES[input.provider];
    const options: AgentSessionCreateOptions = {
      provider: input.provider,
      cwd,
      task: input.task,
      ...(input.model ? { model: input.model } : {}),
      onStep: (step) => {
        entry.steps.push(step);
        if (entry.steps.length > AGENT_SESSION_MAX_STEPS) entry.steps.shift();
        entry.updatedAt = Date.now();
        reportToolProgress(config, "agent_session", step);
      },
    };
    const adapter = await create(options);
    entry.adapter = adapter;
    registry().set(entry.id, entry);
    const turn = entry.chain.then(() => adapter.start());
    entry.chain = turn.then(() => undefined, () => undefined);
    applyResult(entry, await turn);
    return JSON.stringify(output(entry));
  } catch (error) {
    registry().delete(entry.id);
    try { await entry.adapter?.close(); } catch { /* startup failure cleanup is best effort */ }
    const message = error instanceof Error ? error.message : String(error);
    if (/not installed/i.test(message) && /package/i.test(message)) return missingPackage(input.provider);
    return failure("SESSION_START_FAILED", message, { provider: input.provider, cwd });
  }
}

export async function sendAgentSession(
  input: { sessionId: string; prompt: string },
  config?: ToolConfig,
): Promise<string> {
  const entry = sessionFor(input.sessionId, config);
  if (!entry) return failure("SESSION_NOT_FOUND", `No active agent session "${input.sessionId}".`);
  if (entry.state === "closed") return failure("SESSION_CLOSED", `Agent session "${input.sessionId}" is closed.`);
  if (entry.state === "running") return failure("SESSION_BUSY", `Agent session "${input.sessionId}" is already running a turn.`);
  if (!entry.adapter) return failure("SESSION_NOT_STARTED", `Agent session "${input.sessionId}" has no adapter.`);

  entry.state = "running";
  entry.error = null;
  entry.updatedAt = Date.now();
  const adapter = entry.adapter;
  const turn = entry.chain.then(() => adapter.send(input.prompt));
  entry.chain = turn.then(() => undefined, () => undefined);
  try {
    applyResult(entry, await turn);
    return JSON.stringify(output(entry));
  } catch (error) {
    entry.state = "error";
    entry.error = error instanceof Error ? error.message : String(error);
    entry.updatedAt = Date.now();
    return failure("SESSION_TURN_FAILED", entry.error, { session_id: entry.id, provider: entry.provider });
  }
}

export function statusAgentSession(sessionId: string, config?: ToolConfig): string {
  const entry = sessionFor(sessionId, config);
  if (!entry) return failure("SESSION_NOT_FOUND", `No active agent session "${sessionId}".`);
  return JSON.stringify(output(entry));
}

export async function closeAgentSession(sessionId: string, config?: ToolConfig): Promise<string> {
  const entry = sessionFor(sessionId, config);
  if (!entry) return failure("SESSION_NOT_FOUND", `No active agent session "${sessionId}".`);
  try {
    await entry.adapter?.close();
  } catch {
    // Closing is best effort; the local record still goes away.
  }
  registry().delete(sessionId);
  return JSON.stringify({ ok: true, session_id: sessionId, state: "closed" });
}

export function listAgentSessions(config?: ToolConfig): string {
  const caller = threadId(config);
  const sessions = [...registry().values()]
    .filter((entry) => !entry.ownerThreadId || !caller || entry.ownerThreadId === caller)
    .map((entry) => ({
      session_id: entry.id,
      provider: entry.provider,
      state: entry.state,
      cwd: entry.cwd,
      model: entry.model ?? null,
      steps: entry.steps.length,
      updated_at: new Date(entry.updatedAt).toISOString(),
    }));
  return JSON.stringify({ ok: true, sessions });
}

/** Close every adapter; called from lifecycle shutdown. */
export async function closeAllAgentSessions(): Promise<void> {
  const entries = [...registry().values()];
  registry().clear();
  await Promise.all(entries.map(async (entry) => {
    try { await entry.adapter?.close(); } catch { /* best effort */ }
  }));
}

const sessionSchema = z.strictObject({
  action: z.enum(["start", "send", "status", "close", "list"]),
  provider: z.enum(AGENT_SESSION_PROVIDERS).optional(),
  task: z.string().min(1).max(20_000).optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  session_id: z.string().min(1).max(120).optional(),
  cwd: z.string().min(1).max(2_000).optional(),
  model: z.string().min(1).max(200).optional(),
});

export const agentSessionTool = tool(
  async (input, config?: ToolConfig) => {
    switch (input.action) {
      case "start":
        if (!input.provider) return failure("INVALID_INPUT", "provider is required for action='start'.");
        if (!input.task) return failure("INVALID_INPUT", "task is required for action='start'.");
        return startAgentSession({
          provider: input.provider,
          task: input.task,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
        }, config);
      case "send":
        if (!input.session_id) return failure("INVALID_INPUT", "session_id is required for action='send'.");
        if (!input.prompt) return failure("INVALID_INPUT", "prompt is required for action='send'.");
        return sendAgentSession({ sessionId: input.session_id, prompt: input.prompt }, config);
      case "status":
        if (!input.session_id) return failure("INVALID_INPUT", "session_id is required for action='status'.");
        return statusAgentSession(input.session_id, config);
      case "close":
        if (!input.session_id) return failure("INVALID_INPUT", "session_id is required for action='close'.");
        return closeAgentSession(input.session_id, config);
      case "list":
        return listAgentSessions(config);
    }
  },
  {
    name: "agent_session",
    description:
      "Talk to a local coding agent programmatically, without a terminal or TUI. Start a provider session (claude, codex, or copilot), send follow-up turns, inspect progress, close it, or list active sessions. " +
      "Requires the provider's optional agent runtime from Settings → Tools → Packages; a missing runtime returns DEPENDENCY_MISSING and leaves the existing *_delegate tools available. " +
      "Each session is scoped to the current thread and held in memory; close it when done. Under JARELA_TOOL_SAFETY=safe the tool refuses; under mostly_safe (default) and bypass, provider permission requests are approved once and recorded, matching the delegate tools. " +
      "Use this for multi-turn steering and review; use claude_delegate, codex_delegate, or copilot_delegate for one-shot or background jobs.",
    schema: sessionSchema,
  },
);

registerLangChainPackage({ category: "Agent", tools: { execute: [agentSessionTool] } });
