import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setAgentSessionAdapterFactoryForTests,
  agentSessionTool,
  closeAgentSession,
  closeAllAgentSessions,
  listAgentSessions,
  sendAgentSession,
  startAgentSession,
  statusAgentSession,
} from "./agent-session";
import type {
  AgentSessionAdapter,
  AgentSessionCreateOptions,
  AgentSessionProvider,
  AgentSessionTurnResult,
} from "./agent-session-types";
import { _clearRuntimePackageTestOverrides, _setRuntimePackageForTests } from "@/lib/dependencies/runtime-package";
import { registeredCapability, registeredCategory } from "@/lib/tools/runtime/registry";
import type { ToolConfig } from "../filesystem/workspace-context";

const thread = (id: string): ToolConfig => ({ configurable: { thread_id: id } }) as unknown as ToolConfig;

function result(provider: AgentSessionProvider, text: string, steps: string[]): AgentSessionTurnResult {
  return {
    text,
    steps,
    providerSessionId: `${provider}-native`,
    approvals: { approved: 0, denied: 0, mode: provider === "claude" ? "can-use-tool" : provider === "copilot" ? "runtime" : "sandbox" },
  };
}

function fakeAdapter(provider: AgentSessionProvider, options: AgentSessionCreateOptions): AgentSessionAdapter {
  let closed = false;
  return {
    get sessionId() { return `${provider}-native`; },
    async start() {
      options.onStep(`${provider} started`);
      return result(provider, `${provider} started`, [`${provider} started`]);
    },
    async send(prompt) {
      if (closed) throw new Error("closed");
      options.onStep(`${provider} received: ${prompt}`);
      return result(provider, `${provider}: ${prompt}`, [`${provider} received: ${prompt}`]);
    },
    async close() { closed = true; },
  };
}

beforeEach(() => {
  _setAgentSessionAdapterFactoryForTests(async (options) => fakeAdapter(options.provider, options));
  for (const name of ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@microsoft/copilot-sdk"]) {
    _setRuntimePackageForTests(name, {});
  }
});

afterEach(async () => {
  await closeAllAgentSessions();
  _setAgentSessionAdapterFactoryForTests(null);
  _clearRuntimePackageTestOverrides();
  delete process.env.JARELA_TOOL_SAFETY;
});

describe("agent_session lifecycle", () => {
  it("starts, sends, reports, lists and closes a session", async () => {
    const started = JSON.parse(await startAgentSession({ provider: "claude", task: "first", cwd: process.cwd() }, thread("t1")));
    expect(started).toMatchObject({
      ok: true, provider: "claude", state: "ready", result: "claude started",
      provider_session_id: "claude-native",
    });
    const id = started.session_id as string;

    const sent = JSON.parse(await sendAgentSession({ sessionId: id, prompt: "second" }, thread("t1")));
    expect(sent.result).toBe("claude: second");
    expect(sent.steps).toEqual(expect.arrayContaining(["claude started", "claude received: second"]));

    const status = JSON.parse(statusAgentSession(id, thread("t1")));
    expect(status.state).toBe("ready");
    expect(JSON.parse(listAgentSessions(thread("t1"))).sessions).toHaveLength(1);

    const closed = JSON.parse(await closeAgentSession(id, thread("t1")));
    expect(closed).toMatchObject({ ok: true, state: "closed" });
    expect(JSON.parse(statusAgentSession(id, thread("t1"))).code).toBe("SESSION_NOT_FOUND");
  });

  it("scopes sessions to the owning thread", async () => {
    const started = JSON.parse(await startAgentSession({ provider: "codex", task: "first", cwd: process.cwd() }, thread("owner")));
    const id = started.session_id as string;
    expect(JSON.parse(statusAgentSession(id, thread("other"))).code).toBe("SESSION_NOT_FOUND");
    expect(JSON.parse(listAgentSessions(thread("other"))).sessions).toEqual([]);
    expect(JSON.parse(listAgentSessions(thread("owner"))).sessions).toHaveLength(1);
  });

  it("caps concurrent sessions", async () => {
    for (let i = 0; i < 8; i += 1) {
      const started = JSON.parse(await startAgentSession({ provider: "claude", task: `task ${i}`, cwd: process.cwd() }, thread("t1")));
      expect(started.ok).toBe(true);
    }
    const overflow = JSON.parse(await startAgentSession({ provider: "claude", task: "nine", cwd: process.cwd() }, thread("t1")));
    expect(overflow.code).toBe("SESSION_LIMIT");
  });

  it("refuses to start under the safe tier", async () => {
    process.env.JARELA_TOOL_SAFETY = "safe";
    const refused = JSON.parse(await startAgentSession({ provider: "claude", task: "first", cwd: process.cwd() }));
    expect(refused.code).toBe("SAFETY_BLOCKED");
  });

  it("reports a missing optional runtime with the install target", async () => {
    _clearRuntimePackageTestOverrides();
    const missing = JSON.parse(await startAgentSession({ provider: "codex", task: "first", cwd: process.cwd() }));
    expect(missing).toMatchObject({
      ok: false,
      code: "DEPENDENCY_MISSING",
      package: "@openai/codex-sdk",
      install_target: "runtime:@openai/codex-sdk",
    });
  });

  it("registers as an execute tool with a strict schema", () => {
    expect(registeredCategory("agent_session")).toBe("Agent");
    expect(registeredCapability("agent_session")).toBe("execute");
    expect(agentSessionTool.schema.safeParse({ action: "list" }).success).toBe(true);
    expect(agentSessionTool.schema.safeParse({ action: "start", provider: "claude", task: "x", extra: true }).success).toBe(false);
  });
});
