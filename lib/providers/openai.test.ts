import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompletion,
  isOpenAIWebSearchUnsupportedError,
  openAIWebSearchEnabled,
  parseOpenAIInvokeChoice,
  streamOpenAIEvents,
  withOpenAIWebSearch,
} from "./openai";

describe("OpenAI tool argument delivery", () => {
  it.each(['{"path":"notes.md","content"', "null", "[]", '"text"'])(
    "rejects malformed or non-object arguments instead of substituting an empty object: %s",
    (argumentsJson) => {
      expect(() => parseOpenAIInvokeChoice({
        message: { tool_calls: [{ type: "function", id: "t1", function: { name: "file_write", arguments: argumentsJson } }] },
        finish_reason: "tool_calls",
      })).toThrow(/complete JSON object.*not executed/i);
    },
  );

  it("preserves complete large nested arguments", () => {
    const args = { name: "example_update_page", args: { page_id: "synthetic-page", body_storage: "<p>Example.</p>\n".repeat(4_000) } };
    const result = parseOpenAIInvokeChoice({
      message: { tool_calls: [{ type: "function", id: "t1", function: { name: "invoke_tool", arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls",
    });
    expect(result.tool_calls[0].arguments).toEqual(args);
  });

  it("reports truncated calls before attempting to decode their arguments", () => {
    expect(() => parseOpenAIInvokeChoice({
      message: { tool_calls: [{ type: "function", id: "t1", function: { name: "file_write", arguments: '{"content"' } }] },
      finish_reason: "length",
    })).toThrow(/max_tokens.*not executed/i);
  });

  it("does not include input snippets in invalid JSON diagnostics", () => {
    const privateText = "synthetic-private-content";
    try {
      parseOpenAIInvokeChoice({
        message: { tool_calls: [{ type: "function", id: "t1", function: { name: "file_write", arguments: `{"content":"${privateText}` } }] },
        finish_reason: "tool_calls",
      });
      expect.fail("Malformed JSON must be rejected");
    } catch (error) {
      expect(String(error)).toContain("complete JSON object");
      expect(String(error)).not.toContain(privateText);
    }
  });

  it("preserves stop reasons in chunks without a delta", async () => {
    const events = [];
    for await (const event of streamOpenAIEvents((async function* () {
      yield { choices: [{ finish_reason: "length" }] };
    })())) events.push(event);
    expect(events).toEqual([{ type: "stop", reason: "length" }]);
  });
});

describe("OpenAI provider-hosted web search", () => {
  it("requires the explicit opt-in", () => {
    expect(openAIWebSearchEnabled({ openai_web_search: true })).toBe(true);
    expect(openAIWebSearchEnabled({})).toBe(false);
    expect(openAIWebSearchEnabled({ openai_web_search: false })).toBe(false);
  });

  it("adds web_search_options only when enabled", () => {
    const base = { model: "gpt-6.2-astra", messages: [] };
    expect(withOpenAIWebSearch(base, { openai_web_search: true }))
      .toHaveProperty("web_search_options");
    expect(withOpenAIWebSearch(base, {}))
      .not.toHaveProperty("web_search_options");
  });

  it("classifies only clear unsupported-search errors", () => {
    expect(isOpenAIWebSearchUnsupportedError(
      Object.assign(new Error("web_search_options is not supported for this model"), { status: 400 }),
    )).toBe(true);
    expect(isOpenAIWebSearchUnsupportedError(
      Object.assign(new Error("web_search_options is not supported for this model"), { status: 401 }),
    )).toBe(false);
    expect(isOpenAIWebSearchUnsupportedError(
      Object.assign(new Error("Bad request"), { status: 400 }),
    )).toBe(false);
    expect(isOpenAIWebSearchUnsupportedError(new Error("network failure"))).toBe(false);
  });

  it("retries once without hosted search on a clear rejection", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("web_search_options is not supported for this model"),
        { status: 400 },
      ))
      .mockResolvedValueOnce("ok");

    const result = await createOpenAICompletion(create, {
      model: "gpt-6.2-astra",
      web_search_options: {},
    });

    expect(result.response).toBe("ok");
    expect(result.fallbackReason).toMatch(/not supported/);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("web_search_options");
  });

  it("does not retry auth, rate-limit, or unrelated failures", async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await expect(createOpenAICompletion(create, { web_search_options: {} }))
      .rejects.toThrow("Unauthorized");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("maps URL citation annotations to citation events and drops unsafe URLs", async () => {
    const events = [];
    for await (const event of streamOpenAIEvents((async function* () {
      yield {
        choices: [{
          delta: {
            content: "answer",
            annotations: [
              { type: "url_citation", url_citation: { url: "https://example.test/a", title: "Example A" } },
              { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "Unsafe" } },
            ],
          },
        }],
      };
      yield { choices: [{ finish_reason: "stop" }] };
    })())) events.push(event);

    expect(events).toEqual([
      { type: "text", delta: "answer" },
      { type: "citation", url: "https://example.test/a", source: "Example A" },
      { type: "stop", reason: "stop" },
    ]);
  });
});
