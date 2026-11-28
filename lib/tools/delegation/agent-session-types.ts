// Shared contract for programmatic agent sessions (ADR-0137).
//
// One adapter per provider owns its official SDK details. The manager owns
// session identity, thread scoping, turn serialization and bounded history;
// the tool is the model-facing surface.

export const AGENT_SESSION_PROVIDERS = ["claude", "codex", "copilot"] as const;
export type AgentSessionProvider = (typeof AGENT_SESSION_PROVIDERS)[number];

export type AgentSessionState = "running" | "ready" | "closed" | "error";

export interface AgentSessionApprovals {
  approved: number;
  denied: number;
  /** How the provider represents permission decisions in this mode. */
  mode: "can-use-tool" | "sandbox" | "runtime";
}

export interface AgentSessionTurnResult {
  text: string;
  steps: string[];
  providerSessionId: string | null;
  usage?: Record<string, number>;
  approvals: AgentSessionApprovals;
}

export interface AgentSessionCreateOptions {
  provider: AgentSessionProvider;
  cwd: string;
  task: string;
  model?: string;
  /** Called for each human-readable step as the provider works. */
  onStep: (step: string) => void;
}

export interface AgentSessionAdapter {
  /** Provider-native session/thread id once known. */
  readonly sessionId: string | null;
  /** Run the first turn supplied in the create options. */
  start(): Promise<AgentSessionTurnResult>;
  /** Run a follow-up turn in the same provider session. */
  send(prompt: string): Promise<AgentSessionTurnResult>;
  /** Release the provider session. Safe to call more than once. */
  close(): Promise<void>;
}

export type AgentSessionAdapterFactory = (
  options: AgentSessionCreateOptions,
) => Promise<AgentSessionAdapter>;

export interface AgentSessionRecord {
  id: string;
  provider: AgentSessionProvider;
  state: AgentSessionState;
  cwd: string;
  model?: string;
  ownerThreadId?: string;
  providerSessionId: string | null;
  steps: string[];
  result: string | null;
  error: string | null;
  approvals: AgentSessionApprovals;
  createdAt: number;
  updatedAt: number;
}

export const AGENT_SESSION_MAX_STEPS = 200;
export const AGENT_SESSION_MAX_SESSIONS = 8;
