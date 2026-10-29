import { describe, expect, it } from "vitest";
import { parseOpenAIInvokeChoice, streamOpenAIEvents } from "./openai";

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
