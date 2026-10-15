import { describe, expect, it } from "vitest";
import { canMergeIntoTopics, savedMemoryFacts } from "./warm-topics";

const events = (...list: unknown[]) => JSON.stringify(list);

describe("savedMemoryFacts", () => {
  it("counts only saves the tool result confirms, including ones routed through invoke_tool", () => {
    const row = {
      seq: 1,
      content: "",
      tool_events: events(
        { id: "a", phase: "call", name: "invoke_tool", payload: { name: "memory_write", args_json: JSON.stringify({ namespace: "facts", key: "editor", value: "Uses VS Code." }) } },
        { id: "a", phase: "result", name: "invoke_tool", payload: JSON.stringify({ ok: true, namespace: "facts", key: "editor" }) },
        { id: "b", phase: "call", name: "memory_upsert", payload: { namespace: "facts", key: "failed", record: { subject: "Failed" } } },
        { id: "b", phase: "result", name: "memory_upsert", payload: JSON.stringify({ ok: false, error: "denied" }) },
        { id: "c", phase: "call", name: "memory_upsert", payload: { namespace: "facts", key: "mismatch", record: { subject: "Mismatch" } } },
        { id: "c", phase: "result", name: "memory_upsert", payload: JSON.stringify({ ok: true, key: "other" }) },
        { id: "d", phase: "call", name: "memory_write", payload: { namespace: "state", key: "last_run", value: "x" } },
        { id: "d", phase: "result", name: "memory_write", payload: JSON.stringify({ ok: true, key: "last_run" }) },
      ),
    };
    expect(savedMemoryFacts(row)).toEqual([
      { subject: "editor", content: "Uses VS Code.", tags: [], confidence: "explicit", key: "facts/editor", origin: "agent" },
    ]);
  });
});

describe("canMergeIntoTopics", () => {
  const topic = { title: "t", start_seq: 1, end_seq: 4, start_at: "", end_at: "", recap: "r", facts: [], message_count: 4 };

  it("extends stored topics only when the boundary moved forward and every topic carries its counts", () => {
    expect(canMergeIntoTopics([topic], 5, 9)).toBe(true);
    expect(canMergeIntoTopics([topic], 5, 5)).toBe(false);
    expect(canMergeIntoTopics([{ ...topic, message_count: undefined }], 5, 9)).toBe(false);
    expect(canMergeIntoTopics([topic], null, 9)).toBe(false);
  });
});
