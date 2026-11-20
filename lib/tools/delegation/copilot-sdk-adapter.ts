// Thin, injectable seam over `@microsoft/copilot-sdk` (ADR-0120).
//
// The SDK carries a native runtime: in-process hosting loads it through a C
// ABI (FFI) into this process, which gives up crash isolation and pulls a
// platform binary into the Next server. We therefore use the spawned stdio
// transport so the runtime lives in its own child process, and we resolve the
// package at call time (ADR-0122) so it is an on-demand install and unit
// tests never load it. Everything the delegate tool needs is expressed by the
// interfaces below, and tests inject a fake runtime through
// `_setCopilotRuntimeFactoryForTests`.

import { requireRuntimePackage } from "@/lib/dependencies/runtime-package";

export type CopilotPermissionVerdict = "approve" | "deny";
export interface CopilotPermissionPrompt {
  /** Runtime prompt kind: commands, write, read, mcp, url, memory, path, ... */
  kind: string;
  /** Human-readable target: the command text, file path, URL or tool name. */
  detail: string;
}

export interface CopilotSessionOptions {
  sessionId?: string;
  model?: string;
  workingDirectory: string;
  onPermission: (prompt: CopilotPermissionPrompt) => CopilotPermissionVerdict;
  onStep: (step: string) => void;
}

export interface CopilotTurnOptions {
  prompt: string;
  timeoutMs: number;
}

export interface CopilotTurnResult {
  content: string;
}

export interface CopilotSessionHandle {
  sessionId: string;
  turn(options: CopilotTurnOptions): Promise<CopilotTurnResult>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotRuntime {
  createSession(options: CopilotSessionOptions): Promise<CopilotSessionHandle>;
  resumeSession(sessionId: string, options: CopilotSessionOptions): Promise<CopilotSessionHandle>;
  stop(): Promise<void>;
}

export interface CopilotRuntimeConfig {
  /** Runtime binary override; normally empty so the bundled runtime is used. */
  runtimePath?: string;
  /** GitHub token; when absent the runtime uses the logged-in Copilot CLI user. */
  token?: string;
  /** Copilot data directory (session state, config); sets COPILOT_HOME. */
  baseDirectory?: string;
}

export type CopilotRuntimeFactory = () => Promise<CopilotRuntime>;

const MAX_STEP_CHARS = 240;

function compact(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value).replace(/\s+/g, " "); } catch { return ""; }
}

function capped(text: string): string {
  return text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS - 3)}...` : text;
}

/** One line describing a tool invocation argument set, for the step feed. */
export function summarizeToolArguments(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const preferred = ["command", "filePath", "file_path", "path", "fileName", "url", "pattern", "query", "prompt", "description"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return capped(value.replace(/\s+/g, " ").trim());
  }
  return capped(compact(args));
}

interface ToolStartData { toolName?: unknown; toolCallId?: unknown; arguments?: unknown }
interface ToolCompleteData {
  toolCallId?: unknown;
  success?: unknown;
  error?: { message?: unknown } | string;
  result?: { content?: unknown } | unknown;
}

export function describeToolStart(data: ToolStartData): { step: string; toolCallId: string | null; toolName: string | null } {
  const toolName = typeof data.toolName === "string" ? data.toolName : null;
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
  if (!toolName) return { step: "", toolCallId, toolName };
  const detail = summarizeToolArguments(toolName, data.arguments);
  return { step: detail ? `→ ${toolName}: ${detail}` : `→ ${toolName}`, toolCallId, toolName };
}

export function describeToolComplete(data: ToolCompleteData, toolName: string | null): string {
  const name = toolName ?? "tool";
  if (data.success !== false) return `✓ ${name}`;
  const error = typeof data.error === "string"
    ? data.error
    : typeof data.error?.message === "string" ? data.error.message : "";
  return error ? `✗ ${name}: ${capped(error.replace(/\s+/g, " ").trim())}` : `✗ ${name}`;
}

/** Human-readable target for a permission prompt, from the runtime's union. */
export function describePermissionPrompt(request: unknown): CopilotPermissionPrompt {
  const record = (request && typeof request === "object" ? request : {}) as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  const text = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return capped(value.replace(/\s+/g, " ").trim());
    }
    return "";
  };
  const detail = kind === "commands"
    ? text("fullCommandText", "intention")
    : kind === "write"
      ? text("resolvedPath", "fileName", "diff")
      : text("fileName", "filePath", "path", "url", "toolName", "intention");
  return { kind, detail };
}

interface MinimalSession {
  sessionId: string;
  on(event: string, handler: (event: { data?: unknown }) => void): unknown;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data?: { content?: unknown } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

interface MinimalClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  createSession(options: Record<string, unknown>): Promise<MinimalSession>;
  resumeSession(sessionId: string, options: Record<string, unknown>): Promise<MinimalSession>;
}

/**
 * The slice of `@microsoft/copilot-sdk` this adapter uses. Declared locally so
 * the package stays an on-demand runtime (ADR-0122) and typechecking does not
 * require it to be installed.
 */
interface CopilotSdkModule extends Record<string, unknown> {
  CopilotClient: new (options: Record<string, unknown>) => MinimalClient;
  RuntimeConnection: {
    forSpawnedStdio(options: Record<string, unknown>): unknown;
  };
}

function sessionConfig(options: CopilotSessionOptions): Record<string, unknown> {
  return {
    ...(options.model ? { model: options.model } : {}),
    workingDirectory: options.workingDirectory,
    permissions: {
      onRequest: (request: unknown) => options.onPermission(describePermissionPrompt(request)) === "approve"
        ? { kind: "approve-once" }
        : { kind: "reject", feedback: "Rejected by the Jarela delegate permission policy." },
    },
    // No `interaction.onUserInputRequest`: an automated run has nobody to
    // answer a clarifying question, so the ask_user tool stays disabled
    // instead of parking the turn until the timeout.
  };
}

function attachStepFeed(session: MinimalSession, options: CopilotSessionOptions): void {
  const names = new Map<string, string>();
  session.on("tool.execution_start", (event) => {
    const data = (event.data ?? {}) as ToolStartData;
    const described = describeToolStart(data);
    if (described.toolCallId && described.toolName) names.set(described.toolCallId, described.toolName);
    if (described.step) options.onStep(described.step);
  });
  session.on("tool.execution_complete", (event) => {
    const data = (event.data ?? {}) as ToolCompleteData;
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
    const name = toolCallId ? names.get(toolCallId) ?? null : null;
    if (toolCallId) names.delete(toolCallId);
    options.onStep(describeToolComplete(data, name));
  });
  session.on("assistant.message", (event) => {
    const content = (event.data as { content?: unknown } | undefined)?.content;
    if (typeof content === "string" && content.trim()) {
      options.onStep(`Copilot: ${capped(content.replace(/\s+/g, " ").trim())}`);
    }
  });
  session.on("session.error", (event) => {
    const data = (event.data ?? {}) as { message?: unknown; error?: unknown };
    const message = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : "";
    if (message) options.onStep(`✗ session: ${capped(message)}`);
  });
}

function wrapSession(session: MinimalSession, options: CopilotSessionOptions): CopilotSessionHandle {
  attachStepFeed(session, options);
  return {
    sessionId: session.sessionId,
    async turn({ prompt, timeoutMs }) {
      const message = await session.sendAndWait({ prompt }, timeoutMs);
      const content = message?.data?.content;
      return { content: typeof content === "string" ? content.trim() : "" };
    },
    async abort() {
      try { await session.abort(); } catch { /* turn already settled */ }
    },
    async disconnect() {
      try { await session.disconnect(); } catch { /* already disconnected */ }
    },
  };
}

async function createSdkRuntime(config: CopilotRuntimeConfig): Promise<CopilotRuntime> {
  // On-demand runtime package (ADR-0122): resolved from the packages dir so a
  // missing Copilot runtime disables the delegate instead of shipping ~200 MB
  // to every install.
  const sdk = requireRuntimePackage<CopilotSdkModule>(
    "@microsoft/copilot-sdk",
    "The Copilot delegate",
  );
  const client = new sdk.CopilotClient({
    mode: "coding-agent",
    // Spawned transport: the native runtime stays in its own process, so a
    // runtime crash cannot take the Next server down with it.
    runtime: sdk.RuntimeConnection.forSpawnedStdio({
      ...(config.runtimePath ? { path: config.runtimePath } : {}),
      ...(config.baseDirectory ? { baseDirectory: config.baseDirectory } : {}),
    }),
    ...(config.token ? { github: { token: config.token } } : {}),
  }) as unknown as MinimalClient;
  try {
    await client.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Copilot runtime failed to start: ${message}`);
  }
  return {
    createSession: async (options) => wrapSession(await client.createSession({
      ...sessionConfig(options), ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    }), options),
    resumeSession: async (sessionId, options) => wrapSession(await client.resumeSession(sessionId, sessionConfig(options)), options),
    async stop() { await client.stop(); },
  };
}

let runtimeFactory: CopilotRuntimeFactory = () => createSdkRuntime(currentRuntimeConfig());

export interface RuntimeOverrides { runtimePath?: string; token?: string; baseDirectory?: string }

let overrides: RuntimeOverrides = {};

/** Integration/env settings for the next runtime start (see getCopilotConfig). */
export function configureCopilotRuntime(next: RuntimeOverrides): void {
  overrides = { ...next };
}

export function currentRuntimeConfig(): CopilotRuntimeConfig {
  return { ...overrides };
}

/** Test seam: replace the SDK-backed runtime with a fake. */
export function _setCopilotRuntimeFactoryForTests(factory: CopilotRuntimeFactory | null): void {
  runtimeFactory = factory ?? (() => createSdkRuntime(currentRuntimeConfig()));
}

// One runtime per (cli path, token, data dir): starting it spawns a process,
// so delegate calls share it and only sessions are per call.
interface RuntimeSlot { key: string; runtime: Promise<CopilotRuntime> }
const RUNTIME_SYM: unique symbol = Symbol.for("@jarela/copilot-runtime");
type GlobalWithRuntime = typeof globalThis & { [RUNTIME_SYM]?: RuntimeSlot };

export async function copilotRuntime(): Promise<CopilotRuntime> {
  const config = currentRuntimeConfig();
  const key = JSON.stringify([config.runtimePath ?? null, config.token ?? null, config.baseDirectory ?? null]);
  const holder = globalThis as GlobalWithRuntime;
  const existing = holder[RUNTIME_SYM];
  if (existing?.key === key) return existing.runtime;
  const slot: RuntimeSlot = { key, runtime: runtimeFactory() };
  holder[RUNTIME_SYM] = slot;
  try {
    return await slot.runtime;
  } catch (error) {
    if (holder[RUNTIME_SYM] === slot) delete holder[RUNTIME_SYM];
    throw error;
  }
}

/** Stop the shared runtime (lifecycle shutdown / tests). */
export async function stopCopilotRuntime(): Promise<void> {
  const holder = globalThis as GlobalWithRuntime;
  const slot = holder[RUNTIME_SYM];
  if (!slot) return;
  delete holder[RUNTIME_SYM];
  try { await (await slot.runtime).stop(); } catch { /* runtime already gone */ }
}
