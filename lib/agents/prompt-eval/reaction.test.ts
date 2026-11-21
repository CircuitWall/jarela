/**
 * Reaction tier: the real agent loop, minus the model.
 *
 * A scripted provider stands in for the LLM while everything else is the
 * production path — the assembled system prompt is the system message, the
 * registry-built tools are bound, LangGraph runs the ReAct loop, and the real
 * tools execute. That makes the following checkable without a key:
 *
 * - the prompt's permission map actually reaches the model as the tool set,
 * - a correct selection executes and its result is real,
 * - a mistaken selection is visible to the scorer,
 * - a malformed call is refused at the boundary instead of executing.
 *
 * "Would the model choose correctly?" is out of scope here; that is the live
 * tier in live.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { JarelaChatModel } from "@/lib/providers/jarela-chat-model";
import { streamOpenAIEvents } from "@/lib/providers/openai";
import type { ModelProvider, ProviderMessage } from "@/lib/providers/types";
import type { ObservedToolCall, PromptScenario, ScenarioOutcome } from "./types";

const root = mkdtempSync(join(tmpdir(), "jarela-prompt-eval-react-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.JARELA_DB_DIR = join(root, "db");

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* a held handle must not fail the suite */
  }
});

const { getAllTools } = await import("@/lib/tools");
const { getMemory } = await import("@/lib/stores/memory");
const { deleteMemory } = await import("@/lib/stores/memory");
const { findScenario } = await import("./scenarios");
const { buildScenarioPrompt } = await import("./assemble");
const { scoreToolSelection, aggregateOutcomes } = await import("./score");

interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
}

interface Seen {
  toolNames: string[];
  system: string;
}

function systemText(message: ProviderMessage | undefined): string {
  if (!message || typeof message.content === "string") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

/**
 * Replays a fixed tool-call sequence through the real streaming path. The
 * second pass (after tool messages arrive) returns plain text so the loop ends.
 */
function scriptedProvider(calls: readonly ScriptedCall[], seen: Seen): ModelProvider {
  return {
    name: "prompt-eval-scripted",
    async chat() {
      throw new Error("the ReAct loop must use streamInvoke");
    },
    async *streamInvoke(_model, messages, _params, tools) {
      seen.toolNames = tools.map((entry) => entry.function.name);
      const system = (messages as ProviderMessage[]).find((message) => message.role === "system");
      seen.system = typeof system?.content === "string" ? system.content : systemText(system);

      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text", delta: "Finished." };
        yield { type: "stop", reason: "stop" };
        return;
      }

      yield* streamOpenAIEvents((async function* () {
        for (const [index, call] of calls.entries()) {
          const raw = JSON.stringify(call.args);
          for (let offset = 0; offset < raw.length; offset += 512) {
            yield {
              choices: [{
                delta: {
                  tool_calls: [{
                    index,
                    ...(offset === 0 ? { id: `scripted-${index}` } : {}),
                    function: {
                      ...(offset === 0 ? { name: call.name } : {}),
                      arguments: raw.slice(offset, offset + 512),
                    },
                  }],
                },
              }],
            };
          }
        }
        yield { choices: [{ finish_reason: "tool_calls" }] };
      })());
    },
  };
}

async function runScripted(
  scenario: PromptScenario,
  calls: readonly ScriptedCall[],
): Promise<{ seen: Seen; toolMessages: ToolMessage[]; threw: Error | null }> {
  const assembled = await buildScenarioPrompt(scenario);
  const seen: Seen = { toolNames: [], system: "" };
  const model = new JarelaChatModel({ provider: scriptedProvider(calls, seen), modelId: "scripted", params: {} });
  // Binding the prompt's own executable set keeps the offered tools honest.
  const tools = getAllTools({ allow: assembled.boundTools });
  const agent = createReactAgent({ llm: model, tools, prompt: assembled.prompt });

  try {
    const result = await agent.invoke(
      { messages: [new HumanMessage(scenario.request)] },
      { configurable: { thread_id: `prompt-eval-${scenario.id}` } },
    );
    const toolMessages = (result.messages as unknown[]).filter(
      (message): message is ToolMessage => message instanceof ToolMessage,
    );
    return { seen, toolMessages, threw: null };
  } catch (error) {
    return { seen, toolMessages: [], threw: error as Error };
  }
}

const memoryScenario = findScenario("memory-preference-save")!;
const skillScenario = findScenario("skill-guided-procedure")!;
const rangeScenario = findScenario("known-range-file-read")!;

/**
 * LangGraph stores a tool result as an lc-serialized message envelope, so the
 * tool's own JSON lives at `kwargs.content`. Unwrap it instead of asserting on
 * the envelope, which would pass even if the tool never ran.
 */
function toolResult(message: ToolMessage): unknown {
  const raw = String(message.content);
  try {
    const envelope = JSON.parse(raw) as { lc?: number; kwargs?: { content?: unknown } };
    if (envelope && typeof envelope.lc === "number" && envelope.kwargs) {
      const inner = envelope.kwargs.content;
      if (typeof inner !== "string") return inner;
      try {
        return JSON.parse(inner);
      } catch {
        return inner;
      }
    }
    return envelope;
  } catch {
    return raw;
  }
}

function findToolMessage(messages: readonly ToolMessage[], name: string): ToolMessage {
  const found = messages.find((message) => message.name === name);
  expect(found, `${name} did not run`).toBeDefined();
  return found!;
}

describe("prompt reaches the model", () => {
  it.each([memoryScenario, skillScenario, rangeScenario].map((scenario) => [scenario.id, scenario] as const))(
    "sends the assembled prompt and its tool set for %s",
    async (_, scenario) => {
      const call = scenario.expect.tools[0];
      const { seen } = await runScripted(scenario, [{ name: call, args: scenario.expect.validArgs ?? {} }]);

      expect(seen.system, `${scenario.id}: system prompt did not reach the model`).toContain(scenario.promptAnchors[0]);
      for (const name of [...scenario.expect.tools, ...scenario.expect.forbidden]) {
        expect(seen.toolNames, `${scenario.id}: ${name} is executable in the prompt but was not offered`).toContain(name);
      }
    },
  );
});

describe("a correct selection executes against real tools", () => {
  it("writes structured memory with the expected arguments", async () => {
    const key = "pr-description-rollback-plan";
    deleteMemory("facts", key);

    const { toolMessages, threw } = await runScripted(memoryScenario, [
      { name: "memory_upsert", args: memoryScenario.expect.validArgs ?? {} },
    ]);
    expect(threw, threw?.message).toBeNull();

    const call = findToolMessage(toolMessages, "memory_upsert");
    const result = toolResult(call) as { ok: boolean; namespace: string; key: string };
    expect(result).toMatchObject({ ok: true, namespace: "facts", key });
    // The row exists, so the arguments arrived intact rather than being dropped.
    expect(getMemory("facts", key)).not.toBeNull();
  });

  it("loads the skill named in the request", async () => {
    const { toolMessages, threw } = await runScripted(skillScenario, [
      { name: "read_skill", args: { id: "browser-navigation" } },
    ]);
    expect(threw, threw?.message).toBeNull();

    const result = toolResult(findToolMessage(toolMessages, "read_skill")) as { id: string; content: string };
    expect(result.id).toBe("browser-navigation");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("reads the requested line range", async () => {
    const path = join(root, "ranged.txt");
    writeFileSync(path, Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), "utf8");

    const { toolMessages, threw } = await runScripted(rangeScenario, [
      { name: "file_read", args: { path, start_line: 3, end_line: 5 } },
    ]);
    expect(threw, threw?.message).toBeNull();

    const result = toolResult(findToolMessage(toolMessages, "file_read")) as { content: string };
    expect(result.content).toContain("line 3");
    expect(result.content).toContain("line 5");
    expect(result.content).not.toContain("line 2");
  });
});

describe("mistakes are surfaced, not absorbed", () => {
  it("refuses a call that omits a required argument and writes nothing", async () => {
    const key = "pr-description-rollback-plan-invalid";
    deleteMemory("facts", key);

    const { toolMessages, threw } = await runScripted(memoryScenario, [
      { name: "memory_upsert", args: { namespace: "facts", key } },
    ]);

    const evidence = threw
      ? threw.message
      : toolMessages.map((message) => String(message.content)).join("\n");
    expect(
      /required|invalid|expected|received|validation/i.test(evidence),
      `malformed call produced no validation evidence: ${evidence.slice(0, 200)}`,
    ).toBe(true);
    expect(getMemory("facts", key), "a rejected call still wrote memory").toBeNull();
  });

  it("scores a wrong tool choice as a failure", async () => {
    const calls: ObservedToolCall[] = [{ name: "schedule_task", arguments: { when: "tomorrow" } }];
    const selection = scoreToolSelection(memoryScenario, calls);
    expect(selection.pass).toBe(false);
    expect(selection.reasons.join(" ")).toContain("expected one of [memory_upsert]");

    const outcome: ScenarioOutcome = {
      scenario: memoryScenario.id,
      title: memoryScenario.title,
      request: memoryScenario.request,
      provider: "scripted",
      model: "scripted",
      judgeModel: "scripted",
      toolCalls: calls,
      answer: "",
      selection,
      judge: null,
      pass: selection.pass,
      failures: selection.reasons,
    };
    expect(aggregateOutcomes([outcome])).toMatchObject({ total: 1, passed: 0, failed: 1, toolSelectionAccuracy: 0 });
  });
});
