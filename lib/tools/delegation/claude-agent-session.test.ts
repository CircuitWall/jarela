import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAgentSession } from "./claude-agent-session";
import { _clearRuntimePackageTestOverrides, _setRuntimePackageForTests } from "@/lib/dependencies/runtime-package";
import type { AgentSessionCreateOptions } from "./agent-session-types";

interface QueryCall {
  prompt: string;
  options: Record<string, unknown>;
  decision?: unknown;
}

afterEach(() => {
  _clearRuntimePackageTestOverrides();
});

describe("Claude agent session adapter", () => {
  it("streams typed messages, approves via canUseTool, and resumes on the next turn", async () => {
    const calls: QueryCall[] = [];
    async function* fakeQuery(params: { prompt: string; options?: Record<string, unknown> }) {
      const call: QueryCall = { prompt: params.prompt, options: params.options ?? {} };
      calls.push(call);
      yield { type: "system", subtype: "init", session_id: "claude-session", model: "claude-opus-5-5" };
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking at the file." },
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
          ],
        },
      };
      const canUseTool = params.options?.canUseTool as (name: string, input: unknown) => Promise<unknown>;
      call.decision = await canUseTool("Bash", { command: "npm test" });
      yield { type: "result", session_id: "claude-session", result: `done:${params.prompt}`, total_cost_usd: 0.02, num_turns: 1 };
    }
    _setRuntimePackageForTests("@anthropic-ai/claude-agent-sdk", { query: fakeQuery });

    const steps: string[] = [];
    const options: AgentSessionCreateOptions = {
      provider: "claude",
      cwd: process.cwd(),
      task: "first",
      onStep: (step) => steps.push(step),
    };
    const session = await createClaudeAgentSession(options);

    const first = await session.start();
    expect(first).toMatchObject({
      text: "done:first",
      providerSessionId: "claude-session",
      approvals: { approved: 1, denied: 0, mode: "can-use-tool" },
      usage: { total_cost_usd: 0.02, num_turns: 1 },
    });
    expect(first.steps).toEqual(expect.arrayContaining([
      "Claude session ready (claude-opus-5-5)",
      "Claude: Looking at the file.",
      "→ Read: src/a.ts",
      "✓ permission Bash",
    ]));
    expect(calls[0].decision).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(steps).toEqual(expect.arrayContaining(["Claude: Looking at the file.", "✓ permission Bash"]));

    const second = await session.send("second");
    expect(second.text).toBe("done:second");
    expect(calls[1].options.resume).toBe("claude-session");

    await session.close();
    await expect(session.send("after close")).rejects.toThrow(/closed/i);
  });
});
