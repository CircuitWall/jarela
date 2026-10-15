import { describe, expect, it } from "vitest";
import {
  assembleFreshTopics,
  runCompactionPipeline,
  validateTopicGroups,
  validateTopicRecap,
  type PipelineSourceRow,
} from "./compaction-pipeline";
import type { SummaryTopicSegment } from "./conversation-summary";
import type { ProviderMessage } from "@/lib/providers/types";

const row = (seq: number, role = seq % 2 === 0 ? "user" : "assistant", tool_events: string | null = null): PipelineSourceRow => ({
  seq,
  role,
  content: `message ${seq}`,
  created_at: `2026-10-09T10:00:${String(seq).padStart(2, "0")}.000Z`,
  tool_events,
});

const prior: SummaryTopicSegment[] = [{
  title: "Release plan",
  start_seq: 1,
  end_seq: 4,
  start_at: "2026-10-09T09:00:00.000Z",
  end_at: "2026-10-09T09:00:04.000Z",
  recap: "Planned the 2.2.2 patch.",
  facts: [{ subject: "Release cadence", content: "Patch releases ship weekly.", tags: [], confidence: "explicit", key: "facts/release-cadence", origin: "compaction" }],
  message_count: 4,
  source_chars: 40,
}];

const groups = (value: unknown) => JSON.stringify({ groups: value });

function scriptedProvider(script: (messages: ProviderMessage[], call: number) => string) {
  let call = 0;
  const calls: ProviderMessage[][] = [];
  return {
    calls,
    provider: {
      chat: async (_model: string, messages: ProviderMessage[]) => {
        calls.push(messages);
        const text = script(messages, call++);
        return { stream: (async function* () { yield text; })() };
      },
    } as never,
  };
}

describe("step 1 — validateTopicGroups", () => {
  const rows = [10, 11, 12, 13, 14, 15].map((seq) => row(seq));

  it("rejects seqs that were not supplied, overlaps and unknown topic ids, so the model retries", () => {
    expect(validateTopicGroups("not json", rows, prior)).toMatchObject({ ok: false });
    const bad = validateTopicGroups(groups([
      { start_seq: 9, end_seq: 12, title: "a" },
      { start_seq: 12, end_seq: 15, continues: "t7", title: "b" },
    ]), rows, prior);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(" ")).toContain("start_seq 9 is not a supplied message seq");
      expect(bad.errors.join(" ")).toContain('continues "t7" is not an existing topic id');
    }
    const overlap = validateTopicGroups(groups([
      { start_seq: 10, end_seq: 12, title: "a" },
      { start_seq: 12, end_seq: 15, title: "b" },
    ]), rows, prior);
    expect(overlap.ok).toBe(false);
  });

  it("repairs gaps, single-message groups and duplicate continuations in code", () => {
    const result = validateTopicGroups(groups([
      { start_seq: 10, end_seq: 11, continues: "t1", title: "" },
      { start_seq: 13, end_seq: 13, title: "stray" },
      { start_seq: 14, end_seq: 15, continues: "t1", title: "Release plan again" },
    ]), rows, prior);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // seq 12 was ungrouped and joined the first group; the stray single folds
    // in; the second continuation of t1 coalesces into the first.
    expect(result.value).toEqual([{ title: "Release plan", continues: "t1", seqs: [10, 11, 12, 13, 14, 15] }]);
    expect(result.repairs?.length).toBeGreaterThan(0);
  });
});

describe("step 2 — validateTopicRecap", () => {
  const group = { title: "Topic", seqs: [10, 11] };

  it("requires a non-empty recap and rejects a bare sentinel", () => {
    expect(validateTopicRecap("NO_REPLY", group).ok).toBe(false);
    expect(validateTopicRecap(JSON.stringify({ recap: "" }), group).ok).toBe(false);
    expect(validateTopicRecap(JSON.stringify({ recap: "x".repeat(4_001) }), group).ok).toBe(false);
  });

  it("accepts fenced JSON, defaults the title and drops malformed facts", () => {
    const result = validateTopicRecap("```json\n" + JSON.stringify({
      recap: "Newest first.",
      facts: [
        { subject: "Pref", content: "Uses pnpm.", tags: ["tooling"], confidence: "explicit" },
        { subject: "Bad", content: "no confidence" },
      ],
    }) + "\n```", group);
    expect(result).toMatchObject({ ok: true, value: { title: "Topic", recap: "Newest first.", facts: [{ subject: "Pref" }] } });
  });
});

describe("step 3 — assembleFreshTopics", () => {
  it("fails when a supplied message lands in no topic", () => {
    const rows = [row(10), row(11), row(12)];
    const result = assembleFreshTopics([{ title: "a", seqs: [10, 11] }], [{ title: "a", recap: "r", facts: [] }], rows);
    expect(result).toMatchObject({ ok: false, errors: ["seq 12 is in no topic."] });
  });
});

describe("runCompactionPipeline", () => {
  const saved = JSON.stringify([
    { id: "c1", phase: "call", name: "memory_upsert", payload: { namespace: "facts", key: "deploy-target", record: { subject: "Deploy target", content: "Deploys go to staging first.", confidence: "explicit" } } },
    { id: "c1", phase: "result", name: "memory_upsert", payload: { kwargs: { content: JSON.stringify({ ok: true, namespace: "facts", key: "deploy-target" }) } } },
  ]);
  const rows = [row(10), row(11, "assistant", saved), row(12), row(13)];

  it("groups, recaps each topic, and merges into the stored topics newest last", async () => {
    const { provider, calls } = scriptedProvider((messages) => {
      const system = String(messages[0].content);
      if (system.includes("step 1 of 3")) {
        return groups([
          { start_seq: 10, end_seq: 11, continues: "t1", title: "Release plan" },
          { start_seq: 12, end_seq: 13, continues: null, title: "Deploy" },
        ]);
      }
      return String(messages[1].content).includes("Topic: Release plan")
        ? JSON.stringify({ title: "Release plan", recap: "Tagged 2.2.2. Earlier: planned the patch.", facts: [] })
        : JSON.stringify({ title: "Deploy", recap: "Discussed deploy.", facts: [{ subject: "Region", content: "Deploy to eu-west.", tags: [], confidence: "explicit" }] });
    });

    const result = await runCompactionPipeline({ provider, modelId: "m", params: {}, rows, priorTopics: prior, messageLimit: 50 });

    expect(calls).toHaveLength(3);
    expect(result?.topics.map((topic) => [topic.title, topic.message_count])).toEqual([["Release plan", 6], ["Deploy", 2]]);
    const continued = result!.topics[0];
    expect(continued.start_seq).toBe(1);
    expect(continued.end_seq).toBe(11);
    expect(continued.recap).toBe("Tagged 2.2.2. Earlier: planned the patch.");
    // Prior memorized items stay; agent-saved memory is attributed by code.
    expect(continued.facts.map((fact) => fact.key)).toEqual(["facts/release-cadence", "facts/deploy-target"]);
    expect(result!.topics[1].facts[0]).toMatchObject({ key: "facts/region", origin: "compaction" });
    expect(result!.freshTopics.every((topic) => !("continues" in topic))).toBe(true);
    expect(result!.sourceMessages).toBe(8);
  });

  it("retries a step with the validation errors, then succeeds", async () => {
    const { provider, calls } = scriptedProvider((messages, call) => {
      if (call === 0) return groups([{ start_seq: 99, end_seq: 13, title: "x" }]);
      if (String(messages[0].content).includes("step 1 of 3")) return groups([{ start_seq: 10, end_seq: 13, title: "All" }]);
      return JSON.stringify({ recap: "Everything.", facts: [] });
    });
    const result = await runCompactionPipeline({ provider, modelId: "m", params: {}, rows, priorTopics: [], messageLimit: 50 });
    expect(result?.topics).toHaveLength(1);
    const retry = calls[1];
    expect(String(retry[retry.length - 1].content)).toContain("start_seq 99 is not a supplied message seq");
  });

  it("returns null after a step fails twice, so the caller falls back", async () => {
    const { provider, calls } = scriptedProvider(() => "no json here");
    const result = await runCompactionPipeline({ provider, modelId: "m", params: {}, rows, priorTopics: [], messageLimit: 50 });
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("evicts the oldest topics once the merged topics exceed the message limit", async () => {
    const { provider } = scriptedProvider((messages) => String(messages[0].content).includes("step 1 of 3")
      ? groups([{ start_seq: 10, end_seq: 13, title: "New" }])
      : JSON.stringify({ recap: "New work.", facts: [] }));
    const result = await runCompactionPipeline({ provider, modelId: "m", params: {}, rows, priorTopics: prior, messageLimit: 5 });
    expect(result?.topics.map((topic) => topic.title)).toEqual(["New"]);
    expect(result?.evicted).toBe(1);
  });
});
