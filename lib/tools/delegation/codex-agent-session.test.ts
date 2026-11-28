import { afterEach, describe, expect, it } from "vitest";
import { createCodexAgentSession } from "./codex-agent-session";
import { _clearRuntimePackageTestOverrides, _setRuntimePackageForTests } from "@/lib/dependencies/runtime-package";
import type { AgentSessionCreateOptions } from "./agent-session-types";

afterEach(() => {
  _clearRuntimePackageTestOverrides();
});

describe("Codex agent session adapter", () => {
  it("runs streamed turns on one thread and reports the sandbox mode", async () => {
    const prompts: string[] = [];
    let startOptions: Record<string, unknown> | null = null;
    const thread = {
      id: "codex-thread",
      async runStreamed(prompt: string) {
        prompts.push(prompt);
        return (async function* () {
          yield { type: "thread.started", thread_id: "codex-thread" };
          yield { type: "turn.started" };
          yield { type: "item.completed", item: { type: "agent_message", text: `codex:${prompt}` } };
          yield { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } };
        })();
      },
    };
    class FakeCodex {
      startThread(options?: Record<string, unknown>) {
        startOptions = options ?? null;
        return thread;
      }
      resumeThread() { return thread; }
    }
    _setRuntimePackageForTests("@openai/codex-sdk", { Codex: FakeCodex });

    const steps: string[] = [];
    const options: AgentSessionCreateOptions = {
      provider: "codex",
      cwd: process.cwd(),
      task: "first",
      onStep: (step) => steps.push(step),
    };
    const session = await createCodexAgentSession(options);

    const first = await session.start();
    expect(first).toMatchObject({
      text: "codex:first",
      providerSessionId: "codex-thread",
      approvals: { approved: 0, denied: 0, mode: "sandbox" },
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(first.steps).toContain("Codex: codex:first");
    expect(startOptions).toMatchObject({
      workingDirectory: process.cwd(),
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
    });

    const second = await session.send("second");
    expect(second.text).toBe("codex:second");
    expect(prompts).toEqual(["first", "second"]);
    expect(steps).toEqual(expect.arrayContaining(["Codex: codex:first", "Codex: codex:second"]));

    await session.close();
    await expect(session.send("after close")).rejects.toThrow(/not started|closed/i);
  });
});
