import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotAgentSession } from "./copilot-agent-session";
import {
  _setCopilotRuntimeFactoryForTests,
  stopCopilotRuntime,
  type CopilotRuntime,
} from "./copilot-sdk-adapter";
import type { AgentSessionCreateOptions } from "./agent-session-types";

afterEach(async () => {
  await stopCopilotRuntime();
  _setCopilotRuntimeFactoryForTests(null);
});

describe("Copilot agent session adapter", () => {
  it("runs turns on one session, records approvals and disconnects", async () => {
    const disconnect = vi.fn(async () => {});
    let createOptions: Record<string, unknown> | null = null;
    const runtime: CopilotRuntime = {
      async createSession(options) {
        createOptions = options as unknown as Record<string, unknown>;
        return {
          sessionId: "copilot-session",
          async turn({ prompt }) {
            options.onPermission({ kind: "commands", detail: "npm test" });
            options.onStep("Copilot step");
            return { content: `copilot:${prompt}` };
          },
          async abort() {},
          disconnect,
        };
      },
      async resumeSession(_id, options) {
        return this.createSession(options);
      },
      async stop() {},
    };
    _setCopilotRuntimeFactoryForTests(async () => runtime);

    const steps: string[] = [];
    const options: AgentSessionCreateOptions = {
      provider: "copilot",
      cwd: process.cwd(),
      task: "first",
      onStep: (step) => steps.push(step),
    };
    const session = await createCopilotAgentSession(options);

    const first = await session.start();
    expect(first).toMatchObject({
      text: "copilot:first",
      providerSessionId: "copilot-session",
      approvals: { approved: 1, denied: 0, mode: "runtime" },
    });
    expect(first.steps).toEqual(expect.arrayContaining([
      "✓ permission commands npm test",
      "Copilot step",
    ]));
    expect(steps).toEqual(expect.arrayContaining(["Copilot step"]));
    expect(createOptions).toMatchObject({ workingDirectory: process.cwd() });

    const second = await session.send("second");
    expect(second.text).toBe("copilot:second");
    expect(second.approvals.approved).toBe(2);

    await session.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
    await expect(session.send("after close")).rejects.toThrow(/closed/i);
  });
});
