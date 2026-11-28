// Copilot programmatic sessions through the existing @microsoft/copilot-sdk
// adapter (ADR-0120/0122). The SDK session is already typed and supports
// permission callbacks, so this adapter is a thin bridge into the common
// agent-session contract.

import { resolveSubprocessEnv } from "@/lib/tools/security/subprocess-env";
import { getCopilotConfig } from "./copilot-delegate";
import {
  configureCopilotRuntime,
  copilotRuntime,
  type CopilotPermissionPrompt,
  type CopilotSessionHandle,
} from "./copilot-sdk-adapter";
import type {
  AgentSessionAdapter,
  AgentSessionApprovals,
  AgentSessionCreateOptions,
  AgentSessionTurnResult,
} from "./agent-session-types";

interface CopilotSessionState {
  turnSteps: string[];
  approvals: AgentSessionApprovals;
}

class CopilotAgentSession implements AgentSessionAdapter {
  private closed = false;

  constructor(
    private readonly session: CopilotSessionHandle,
    private readonly options: AgentSessionCreateOptions,
    private readonly timeoutMs: number,
    private readonly state: CopilotSessionState,
  ) {}

  get sessionId(): string | null { return this.session.sessionId; }

  start(): Promise<AgentSessionTurnResult> {
    return this.run(this.options.task);
  }

  async send(prompt: string): Promise<AgentSessionTurnResult> {
    if (this.closed) throw new Error("Copilot session is closed");
    return this.run(prompt);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.session.disconnect();
  }

  private async run(prompt: string): Promise<AgentSessionTurnResult> {
    this.state.turnSteps = [];
    const turn = await this.session.turn({ prompt, timeoutMs: this.timeoutMs });
    return {
      text: turn.content,
      steps: [...this.state.turnSteps],
      providerSessionId: this.session.sessionId,
      approvals: { ...this.state.approvals },
    };
  }
}

export async function createCopilotAgentSession(
  options: AgentSessionCreateOptions,
): Promise<AgentSessionAdapter> {
  const config = getCopilotConfig();
  configureCopilotRuntime({
    runtimePath: config.runtimePath,
    token: config.token,
    baseDirectory: config.baseDirectory,
  });
  const { cwd } = resolveSubprocessEnv({ cwd: options.cwd });

  const state: CopilotSessionState = {
    turnSteps: [],
    approvals: { approved: 0, denied: 0, mode: "runtime" },
  };
  const onStep = (step: string) => {
    state.turnSteps.push(step);
    options.onStep(step);
  };
  const onPermission = (prompt: CopilotPermissionPrompt): "approve" | "deny" => {
    // Matches copilot_delegate: under mostly_safe/bypass an interactive user
    // would approve each prompt, so record it and continue.
    state.approvals.approved += 1;
    const detail = prompt.detail ? ` ${prompt.detail}` : "";
    onStep(`✓ permission ${prompt.kind}${detail}`);
    return "approve";
  };

  const session = await (await copilotRuntime()).createSession({
    workingDirectory: cwd,
    ...(options.model ? { model: options.model } : {}),
    onPermission,
    onStep,
  });
  return new CopilotAgentSession(session, options, config.timeoutSeconds * 1000, state);
}
