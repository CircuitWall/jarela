// Codex programmatic sessions through the official @openai/codex-sdk.
//
// The SDK wraps the local Codex CLI and exchanges JSONL events. Each Jarela
// session owns one Codex thread and reuses it for follow-up turns. Codex's SDK
// exposes sandbox/approval configuration rather than a live permission
// callback, so the record reports the configured sandbox rather than inventing
// per-request approvals.

import { requireRuntimePackage } from "@/lib/dependencies/runtime-package";
import { resolveSubprocessEnv } from "@/lib/tools/security/subprocess-env";
import { getCodexConfig } from "./codex-delegate";
import type {
  AgentSessionAdapter,
  AgentSessionCreateOptions,
  AgentSessionTurnResult,
} from "./agent-session-types";

const MAX_STEP_CHARS = 240;

type CodexItem = {
  type?: string;
  text?: string;
  command?: string | string[];
  status?: string;
  error?: { message?: string } | string;
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string } | string;
  usage?: Record<string, number>;
};

interface CodexThread {
  id: string;
  runStreamed(prompt: string): Promise<AsyncIterable<CodexEvent>>;
}

interface CodexClient {
  startThread(options?: Record<string, unknown>): CodexThread;
  resumeThread(threadId: string, options?: Record<string, unknown>): CodexThread;
}

interface CodexSdkModule extends Record<string, unknown> {
  Codex: new (options?: Record<string, unknown>) => CodexClient;
}

function capped(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  return compact.length > MAX_STEP_CHARS ? `${compact.slice(0, MAX_STEP_CHARS - 3)}...` : compact;
}

function codexEnv(cwd: string): Record<string, string> {
  const env = resolveSubprocessEnv({ cwd });
  const extra = getCodexConfig().env;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") merged[key] = value;
  }
  return { ...merged, ...extra };
}

function itemStep(item: CodexItem): string | null {
  switch (item.type) {
    case "agent_message":
      return item.text ? `Codex: ${capped(item.text)}` : null;
    case "reasoning":
      return "Codex: reasoning";
    case "command_execution": {
      const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
      return command ? `→ ${capped(command)}` : "→ command";
    }
    case "file_change":
      return "→ file change";
    case "mcp_tool_call":
      return "→ MCP tool call";
    case "web_search":
      return "→ web search";
    case "todo_list":
      return "Codex: todo list updated";
    case "error":
      return `✗ ${capped(item.error ?? "Codex error")}`;
    default:
      return null;
  }
}

class CodexAgentSession implements AgentSessionAdapter {
  private thread: CodexThread | null = null;
  private closed = false;

  constructor(
    private readonly client: CodexClient,
    private readonly options: AgentSessionCreateOptions,
  ) {}

  get sessionId(): string | null { return this.thread?.id ?? null; }

  start(): Promise<AgentSessionTurnResult> {
    this.thread = this.client.startThread(this.threadOptions());
    return this.run(this.options.task);
  }

  async send(prompt: string): Promise<AgentSessionTurnResult> {
    if (this.closed || !this.thread) throw new Error("Codex session is not started");
    return this.run(prompt);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.thread = null;
  }

  private threadOptions(): Record<string, unknown> {
    return {
      workingDirectory: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
    };
  }

  private async run(prompt: string): Promise<AgentSessionTurnResult> {
    if (!this.thread) throw new Error("Codex session is not started");
    const steps: string[] = [];
    let text = "";
    let usage: Record<string, number> | undefined;
    const stream = await this.thread.runStreamed(prompt);
    for await (const event of stream) {
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        // The SDK already knows the thread; keep the id for status consumers.
        steps.push(`Codex thread ${event.thread_id.slice(0, 8)}`);
      } else if (event.type === "turn.started") {
        steps.push("Codex turn started");
      } else if (event.type === "item.completed" && event.item) {
        const step = itemStep(event.item);
        if (step) {
          steps.push(step);
          this.options.onStep(step);
        }
        if (event.item.type === "agent_message" && event.item.text) text = event.item.text.trim();
      } else if (event.type === "turn.completed") {
        if (event.usage) usage = event.usage;
        steps.push("Codex turn completed");
      } else if (event.type === "turn.failed") {
        throw new Error(capped(event.error ?? "Codex turn failed"));
      }
    }
    return {
      text,
      steps,
      providerSessionId: this.thread.id,
      ...(usage ? { usage } : {}),
      approvals: { approved: 0, denied: 0, mode: "sandbox" },
    };
  }
}

export async function createCodexAgentSession(
  options: AgentSessionCreateOptions,
): Promise<AgentSessionAdapter> {
  const sdk = requireRuntimePackage<CodexSdkModule>(
    "@openai/codex-sdk",
    "Codex agent sessions",
  );
  const client = new sdk.Codex({ env: codexEnv(options.cwd) });
  return new CodexAgentSession(client, options);
}
