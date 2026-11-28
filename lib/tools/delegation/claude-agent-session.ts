// Claude Code programmatic sessions through the official Claude Agent SDK.
//
// The SDK is optional (ADR-0122/0137): resolving it fails with the standard
// RuntimePackageUnavailableError when the package is not installed, and the
// manager turns that into a structured DEPENDENCY_MISSING result. Each turn
// uses the SDK's session resume so the provider keeps its own history; the
// adapter never parses or renders a TUI.

import { resolveSubprocessEnv } from "@/lib/tools/security/subprocess-env";
import { requireRuntimePackage } from "@/lib/dependencies/runtime-package";
import type {
  AgentSessionAdapter,
  AgentSessionApprovals,
  AgentSessionCreateOptions,
  AgentSessionTurnResult,
} from "./agent-session-types";

const MAX_STEP_CHARS = 240;

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
};

type ClaudeMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  message?: { content?: ClaudeContentBlock[] };
};

interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
}

interface ClaudeSdkModule extends Record<string, unknown> {
  query: (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }) => ClaudeQuery;
}

function compact(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value === null || value === undefined) return "";
  try { return JSON.stringify(value).replace(/\s+/g, " "); } catch { return ""; }
}

function capped(text: string): string {
  return text.length > MAX_STEP_CHARS ? `${text.slice(0, MAX_STEP_CHARS - 3)}...` : text;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return capped(`${name}: ${value.trim()}`);
  }
  const text = compact(input);
  return text ? capped(`${name}: ${text}`) : name;
}

function claudeEnv(cwd: string): Record<string, string> {
  const env = resolveSubprocessEnv({ cwd });
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

class ClaudeAgentSession implements AgentSessionAdapter {
  private providerSessionId: string | null = null;
  private closed = false;

  constructor(
    private readonly sdk: ClaudeSdkModule,
    private readonly options: AgentSessionCreateOptions,
  ) {}

  get sessionId(): string | null { return this.providerSessionId; }

  start(): Promise<AgentSessionTurnResult> {
    return this.run(this.options.task);
  }

  async send(prompt: string): Promise<AgentSessionTurnResult> {
    if (this.closed) throw new Error("Claude session is closed");
    return this.run(prompt);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async run(prompt: string): Promise<AgentSessionTurnResult> {
    const steps: string[] = [];
    const approvals: AgentSessionApprovals = { approved: 0, denied: 0, mode: "can-use-tool" };
    let text = "";
    let usage: Record<string, number> | undefined;

    const query = this.sdk.query({
      prompt,
      options: {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.providerSessionId ? { resume: this.providerSessionId } : {}),
        // Stay in the normal permission flow so canUseTool sees each request.
        permissionMode: "default",
        env: claudeEnv(this.options.cwd),
        canUseTool: async (toolName: string, input: unknown) => {
          approvals.approved += 1;
          const step = `✓ permission ${toolName}`;
          steps.push(step);
          this.options.onStep(step);
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    for await (const message of query) {
      if (message.type === "system" && message.subtype === "init") {
        if (typeof message.session_id === "string") this.providerSessionId = message.session_id;
        if (typeof message.model === "string") {
          const step = `Claude session ready (${message.model})`;
          steps.push(step);
          this.options.onStep(step);
        }
        continue;
      }
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            const step = `Claude: ${capped(block.text.trim())}`;
            steps.push(step);
            this.options.onStep(step);
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const step = `→ ${summarizeToolInput(block.name, block.input)}`;
            steps.push(step);
            this.options.onStep(step);
          }
        }
        continue;
      }
      if (message.type === "user") {
        for (const block of message.message?.content ?? []) {
          if (!block || typeof block !== "object") continue;
          const kind = block.type === "tool_result" ? (block.is_error ? "✗ tool result" : "✓ tool result") : "";
          if (!kind) continue;
          steps.push(kind);
          this.options.onStep(kind);
        }
        continue;
      }
      if (message.type === "result") {
        if (typeof message.session_id === "string") this.providerSessionId = message.session_id;
        if (typeof message.result === "string") text = message.result.trim();
        if (message.is_error) {
          const step = `✗ Claude result failed`;
          steps.push(step);
          this.options.onStep(step);
        }
        const total = message.total_cost_usd;
        if (typeof total === "number") usage = { total_cost_usd: total };
        if (typeof message.num_turns === "number") usage = { ...(usage ?? {}), num_turns: message.num_turns };
      }
    }

    return {
      text,
      steps,
      providerSessionId: this.providerSessionId,
      ...(usage ? { usage } : {}),
      approvals,
    };
  }
}

export async function createClaudeAgentSession(
  options: AgentSessionCreateOptions,
): Promise<AgentSessionAdapter> {
  const sdk = requireRuntimePackage<ClaudeSdkModule>(
    "@anthropic-ai/claude-agent-sdk",
    "Claude agent sessions",
  );
  return new ClaudeAgentSession(sdk, options);
}
