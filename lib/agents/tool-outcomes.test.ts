import { describe, expect, it } from "vitest";
import { ToolOutcomes } from "./tool-outcomes";

describe("ToolOutcomes", () => {
  it.each([false, true])("keeps asynchronous work pending (proxied=%s)", (proxied) => {
    const outcomes = new ToolOutcomes();
    const handoff = { ok: true, async: true, key: "synthetic-job", tool: "file_write" };
    outcomes.observe({
      type: "tool_call",
      data: { id: "call", name: proxied ? "invoke_tool" : "file_write", arguments: { name: "file_write" } },
    });
    outcomes.observe({
      type: "tool_result",
      data: {
        id: "call", name: proxied ? "invoke_tool" : "file_write",
        result: JSON.stringify(proxied ? { ok: true, tool: "file_write", status: "done", result: JSON.stringify(handoff) } : handoff),
      },
    });

    expect(outcomes.successfulNames()).toEqual([]);
    expect(outcomes.possiblyChangedNames()).toEqual(["file_write"]);
  });

  it("keeps failures ahead of asynchronous bookkeeping and accepts completed results", () => {
    const outcomes = new ToolOutcomes();
    outcomes.observe({ type: "tool_call", data: { id: "call", name: "file_write", arguments: {} } });
    outcomes.observe({
      type: "tool_result",
      data: { id: "call", name: "file_write", status: "error", result: { ok: true, async: true } },
    });
    expect(outcomes.successfulNames()).toEqual([]);
    expect(outcomes.possiblyChangedNames()).toEqual(["file_write"]);
    outcomes.observe({
      type: "tool_result",
      data: { id: "call", name: "file_write", result: { ok: true, path: "synthetic.txt" } },
    });
    expect(outcomes.successfulNames()).toEqual(["file_write"]);
  });

  it("excludes rejected calls from possible side effects", () => {
    const outcomes = new ToolOutcomes();
    outcomes.observe({ type: "tool_call", data: { id: "call", name: "invoke_tool", arguments: { name: "file_write" } } });
    outcomes.observe({
      type: "tool_result",
      data: { id: "call", name: "invoke_tool", result: { ok: false, status: "rejected", error: "Denied" } },
    });
    expect(outcomes.successfulNames()).toEqual([]);
    expect(outcomes.possiblyChangedNames()).toEqual([]);
  });
});
