import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { JarelaChatModel } from "@/lib/providers/jarela-chat-model";
import { streamOpenAIEvents } from "@/lib/providers/openai";
import type { ModelProvider } from "@/lib/providers/types";

const root = mkdtempSync(join(tmpdir(), "jarela-test-argument-delivery-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.JARELA_DB_DIR = join(root, "db");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { getAllTools } = await import("@/lib/tools");
const { registerTools } = await import("@/lib/tools/runtime/registry");
const { createSkillRepo } = await import("@/lib/stores/skill-repos");
const { wrapToolsForRehydrate } = await import("@/lib/redaction/wrap-tools");
const { wrapToolsForCredentialRouting } = await import("@/lib/tools/security/wrap-credentials");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const received = vi.fn(async (_input: { page_id: string; body_storage: string }) => JSON.stringify({ ok: true }));
registerTools("Files", "write", [tool(received, {
  name: "test_update_page",
  description: "Synthetic local argument receiver; no network.",
  schema: z.object({ page_id: z.string(), body_storage: z.string() }),
})]);
createSkillRepo({ path: join(root, "skills") });

interface Call {
  name: string;
  raw: string;
}

function providerFor(calls: Call[]): ModelProvider {
  return {
    name: "test",
    async chat() { throw new Error("Unexpected chat fallback"); },
    async *streamInvoke(_model, messages, _params, tools) {
      expect(tools.find((entry) => entry.function.name === "write_skill")?.function.parameters)
        .toMatchObject({ required: expect.arrayContaining(["id", "content"]) });
      if (messages.some((message) => message.role === "tool")) {
        yield { type: "text", delta: "Completed." };
        yield { type: "stop", reason: "stop" };
        return;
      }
      yield* streamOpenAIEvents((async function* () {
        for (let offset = 0; offset < Math.max(...calls.map((call) => call.raw.length)); offset += 97) {
          for (const [index, call] of calls.entries()) {
            if (offset >= call.raw.length) continue;
            yield { choices: [{ delta: { tool_calls: [{
              index,
              ...(offset === 0 ? { id: `t${index}` } : {}),
              function: {
                ...(offset === 0 ? { name: call.name } : {}),
                arguments: call.raw.slice(offset, offset + 97),
              },
            }] } }] };
          }
        }
        yield { choices: [{ finish_reason: "tool_calls" }] };
      })());
    },
  };
}

async function run(calls: Call[], mode: "invoke" | "stream") {
  const model = new JarelaChatModel({ provider: providerFor(calls), modelId: "synthetic", params: {} });
  const tools = wrapToolsForCredentialRouting(wrapToolsForRehydrate(getAllTools({
    allow: ["write_skill", "file_write", "invoke_tool"],
  })), { write_skill: "synthetic-override" });
  const agent = createReactAgent({ llm: model, tools });
  upsertAgentConfig({ id: "argument-delivery", name: "Argument delivery", identity: "test", instructions: "", tools: [] });
  const thread = createThread("argument-delivery");
  const input = { messages: [new HumanMessage("Write the supplied synthetic documents.")] };
  const config = { configurable: { thread_id: thread.thread_id } };
  if (mode === "invoke") await agent.invoke(input, config);
  else for await (const _chunk of await agent.stream(input, { ...config, streamMode: ["messages", "updates"] })) { /* drain */ }
}

describe("provider fragments through LangGraph and real write tools", () => {
  const content = '# Synthetic skill\r\n\r\nQuotes: "example"; slash: \\\\; Unicode: \u00e9 \u{1f600}\r\n'.repeat(1_000);
  const html = '<h1>Synthetic</h1><p title="example">Text &amp; details.</p>\n'.repeat(1_000);

  it.each(["invoke", "stream"] as const)("preserves large bodies for direct and proxied calls (%s)", async (mode) => {
    received.mockClear();
    const path = join(root, `document-${mode}.html`);
    const id = `synthetic-${mode}`;
    await run([
      { name: "write_skill", raw: JSON.stringify({ id, content }) },
      { name: "file_write", raw: JSON.stringify({ path, content: html }) },
      { name: "invoke_tool", raw: JSON.stringify({ name: "test_update_page", args: { page_id: "structured", body_storage: html } }) },
      { name: "invoke_tool", raw: JSON.stringify({ name: "test_update_page", args: {}, args_json: JSON.stringify({ page_id: "json-string", body_storage: html }) }) },
    ], mode);
    expect(readFileSync(join(root, "skills", id, "SKILL.md"), "utf8")).toBe(content);
    expect(readFileSync(path, "utf8")).toBe(html);
    expect(received).toHaveBeenCalledTimes(2);
    expect(received.mock.calls.map(([args]) => args).sort((a, b) => a.page_id.localeCompare(b.page_id)))
      .toEqual([{ page_id: "json-string", body_storage: html }, { page_id: "structured", body_storage: html }]);
  });

  it.each(["invoke", "stream"] as const)("never dispatches a batch containing unfinished arguments (%s)", async (mode) => {
    received.mockClear();
    const path = join(root, `must-not-exist-${mode}.txt`);
    await expect(run([
      { name: "file_write", raw: JSON.stringify({ path, content: "Must not be written" }) },
      { name: "write_skill", raw: '{"id":"unfinished","content"' },
    ], mode)).rejects.toThrow(/complete JSON object.*not executed/i);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, "skills", "unfinished"))).toBe(false);
    expect(received).not.toHaveBeenCalled();
  });
});
