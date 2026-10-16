import { describe, expect, it } from "vitest";
import type { SummaryTopicFact, SummaryTopicSegment } from "./conversation-summary";
import {
  canMergeIntoTopics,
  finalizeTopic,
  foldSingleMessageTopics,
  mergeTopicFacts,
  mergeWarmTopics,
  savedMemoryFacts,
  slugifyForMemoryKey,
} from "./warm-topics";

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

const fact = (subject: string, key?: string, content = subject): SummaryTopicFact => ({
  subject, content, tags: [], confidence: "explicit", ...(key ? { key } : {}),
});

const topic = (start: number, end: number, extra: Partial<SummaryTopicSegment> = {}): SummaryTopicSegment => ({
  title: `T${start}-${end}`,
  start_seq: start,
  end_seq: end,
  start_at: null,
  end_at: null,
  recap: `recap ${start}-${end}`,
  facts: [],
  ...extra,
} as SummaryTopicSegment);

const rowsFor = (...seqs: number[]) => seqs.map((seq) => ({ seq, content: `message ${seq}` }));

describe("slugifyForMemoryKey", () => {
  it("keeps non-Latin subjects distinct instead of collapsing them to an empty key", () => {
    const a = slugifyForMemoryKey("发布节奏");
    const b = slugifyForMemoryKey("部署目标");
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    expect(a).not.toBe(b);
    expect(slugifyForMemoryKey("Café Öffnungszeiten")).toBe("café-öffnungszeiten");
  });

  it("falls back to a stable non-empty key for subjects with no letters or digits", () => {
    const key = slugifyForMemoryKey("🚀🚀");
    expect(key).toMatch(/^fact-[0-9a-f]+$/);
    expect(slugifyForMemoryKey("🚀🚀")).toBe(key);
    expect(slugifyForMemoryKey("🎉")).not.toBe(key);
  });

  it("caps the key length and trims separators", () => {
    expect(slugifyForMemoryKey("  --Release   Cadence!!  ")).toBe("release-cadence");
    expect(slugifyForMemoryKey("x".repeat(200))).toHaveLength(80);
  });
});

describe("mergeTopicFacts", () => {
  it("merges by subject case-insensitively, later lists winning", () => {
    const merged = mergeTopicFacts([fact("Editor", undefined, "old")], [fact("editor", undefined, "new")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("new");
  });

  it("replaces a fact saved under the same key even when the subject was reworded", () => {
    const merged = mergeTopicFacts([fact("Editor", "facts/editor", "VS Code")], [fact("Preferred editor", "facts/editor", "Zed")]);
    expect(merged.map((f) => f.content)).toEqual(["Zed"]);
  });

  it("does not drop an unrelated fact through a key the subject no longer uses", () => {
    const merged = mergeTopicFacts(
      [fact("Region", "facts/region-old")],
      [fact("Region", "facts/region")],
      [fact("Old region alias", "facts/region-old")],
    );
    expect(merged.map((f) => f.key)).toEqual(["facts/region", "facts/region-old"]);
  });

  it("keeps the newest 16 facts", () => {
    const merged = mergeTopicFacts(Array.from({ length: 20 }, (_, i) => fact(`s${i}`)));
    expect(merged).toHaveLength(16);
    expect(merged[0].subject).toBe("s4");
    expect(merged[15].subject).toBe("s19");
  });
});

describe("foldSingleMessageTopics", () => {
  it("folds a leading single-message topic forward and a later one backward", () => {
    const folded = foldSingleMessageTopics(
      [topic(1, 1, { recap: "a" }), topic(2, 4, { recap: "b" }), topic(5, 5, { recap: "c" })],
      rowsFor(1, 2, 3, 4, 5),
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ start_seq: 1, end_seq: 5, recap: "a b c" });
  });

  it("counts rows, not seq width, so gaps from pruned rows still fold", () => {
    const folded = foldSingleMessageTopics([topic(1, 3), topic(4, 9)], rowsFor(1, 2, 3, 9));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ start_seq: 1, end_seq: 9 });
  });

  it("leaves a lone topic alone even when it covers one message", () => {
    expect(foldSingleMessageTopics([topic(1, 1)], rowsFor(1))).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const input = [topic(1, 1, { facts: [fact("a")] }), topic(2, 3, { facts: [fact("b")] })];
    const snapshot = structuredClone(input);
    foldSingleMessageTopics(input, rowsFor(1, 2, 3));
    expect(input).toEqual(snapshot);
  });
});

describe("finalizeTopic", () => {
  it("derives keys and counts in code and merges memory the agent saved in range", () => {
    const covered = [
      { seq: 1, content: "hello" },
      {
        seq: 2,
        content: "saved",
        tool_events: events(
          { id: "m", phase: "call", name: "memory_write", payload: { namespace: "facts", key: "tz", value: "Europe/Amsterdam" } },
          { id: "m", phase: "result", name: "memory_write", payload: JSON.stringify({ ok: true, key: "tz" }) },
        ),
      },
    ];
    const out = finalizeTopic(topic(1, 2, { facts: [fact("Release cadence")] }), covered);
    expect(out.message_count).toBe(2);
    expect(out.source_chars).toBe("hello".length + "saved".length);
    expect(out.facts).toEqual([
      expect.objectContaining({ key: "facts/release-cadence", origin: "compaction" }),
      expect.objectContaining({ key: "facts/tz", origin: "agent", content: "Europe/Amsterdam" }),
    ]);
  });
});

describe("mergeWarmTopics", () => {
  it("updates a continued topic in place, keeps its start, sums counts and re-sorts by recency", () => {
    const prior = [topic(1, 4, { message_count: 4, source_chars: 40 }), topic(5, 8, { message_count: 4, source_chars: 40 })];
    const fresh = [topic(9, 12, { continues: "t1", recap: "newer", message_count: 4, source_chars: 10 })];
    const merged = mergeWarmTopics(prior, fresh, 100);
    expect(merged.topics.map((t) => [t.start_seq, t.end_seq])).toEqual([[5, 8], [1, 12]]);
    expect(merged.topics[1]).toMatchObject({ recap: "newer", message_count: 8, source_chars: 50 });
    expect(merged.topics[1]).not.toHaveProperty("continues");
  });

  it("appends a fresh topic whose continues id does not exist", () => {
    const merged = mergeWarmTopics([topic(1, 4, { message_count: 4 })], [topic(5, 8, { continues: "t9", message_count: 4 })], 100);
    expect(merged.topics).toHaveLength(2);
    expect(merged.topics[1]).not.toHaveProperty("continues");
  });

  it("evicts the least recently active topics until within the limit, keeping at least one", () => {
    const prior = [topic(1, 4, { message_count: 4 }), topic(5, 8, { message_count: 4 })];
    const merged = mergeWarmTopics(prior, [topic(9, 20, { message_count: 12 })], 10);
    expect(merged.evicted).toBe(2);
    expect(merged.topics.map((t) => t.start_seq)).toEqual([9]);
    expect(merged.sourceMessages).toBe(10);
  });
});