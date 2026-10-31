import { describe, it, expect, vi } from "vitest";
import { extractTopicSegments, parseStoredTopics, summarizeTranscript, transcriptText, validateTopicSegments } from "./conversation-summary";
import type { ModelProvider, ProviderMessage, ProviderParams } from "@/lib/providers/types";

describe("parseStoredTopics", () => {
  it.each([undefined, null, "", "{", "null", "{}", '"text"'])("keeps null fallback for %s", (raw) => {
    expect(parseStoredTopics(raw)).toBeNull();
  });

  it("keeps stored pipeline array fields intact without introducing response validation", () => {
    const topics = [{ title: "Synthetic", start_seq: 1, source_chars: 100, extra: true }];
    expect(parseStoredTopics(JSON.stringify(topics))).toEqual(topics);
    expect(parseStoredTopics("[]")).toEqual([]);
  });
});

describe("transcriptText", () => {
  it("returns plain text unchanged", () => {
    expect(transcriptText("hello")).toBe("hello");
  });

  it("flattens content parts and stubs attachments", () => {
    const raw = JSON.stringify([
      { type: "text", text: "hello" },
      { type: "image", media_type: "image/png", data: "a" },
      { type: "file", name: "report.pdf", media_type: "application/pdf", data: "b" },
    ]);
    expect(transcriptText(raw)).toContain("hello");
    expect(transcriptText(raw)).toContain("[image attachment: image/png]");
    expect(transcriptText(raw)).toContain("[file attachment: report.pdf (application/pdf)]");
  });

  it("falls back to raw when JSON is malformed", () => {
    expect(transcriptText("[not-json")).toBe("[not-json");
  });
});

describe("topic compaction validation", () => {
  const rows = [
    { seq: 1, created_at: "2026-10-10T10:00:00.000Z" },
    { seq: 2, created_at: "2026-10-10T10:00:01.000Z" },
    { seq: 3, created_at: "2026-10-10T10:01:00.000Z" },
    { seq: 4, created_at: "2026-10-10T10:01:01.000Z" },
  ];

  function topic(start_seq: number, end_seq: number, title = `topic ${start_seq}`) {
    return {
      title,
      start_seq,
      end_seq,
      start_at: rows.find((row) => row.seq === start_seq)?.created_at ?? "2026-10-10T09:00:00.000Z",
      end_at: rows.find((row) => row.seq === end_seq)?.created_at ?? "2026-10-10T09:00:00.000Z",
      recap: `${title} recap`,
      facts: [],
    };
  }

  it("validates exact source ranges and marks a topic cut by the warm limit as partial", () => {
    const valid = validateTopicSegments(
      [{ ...topic(1, 3), partial_start: true }, topic(4, 4)],
      rows,
      rows.slice(2),
      { boundarySeq: 5, allowPartialStart: true },
    );

    expect(valid.map((segment) => [segment.start_seq, segment.end_seq, segment.partial_start])).toEqual([
      [3, 3, true],
      [4, 4, undefined],
    ]);
  });

  it("rejects fabricated, overlapping, and hot-crossing ranges", () => {
    const valid = validateTopicSegments(
      [topic(1, 3), topic(2, 3), topic(90, 91)],
      rows,
      rows,
      { boundarySeq: 4 },
    );

    expect(valid.map((segment) => [segment.start_seq, segment.end_seq])).toEqual([[1, 3]]);
  });

  it("uses seq membership as truth while treating timestamps as display labels", () => {
    const labelMismatch = { ...topic(1, 2), end_at: "2026-10-10T10:09:00.000Z" };
    const valid = validateTopicSegments([labelMismatch], rows, rows, { boundarySeq: 4 });

    expect(valid.map((segment) => [segment.start_seq, segment.end_seq])).toEqual([[1, 2]]);
  });

  it("rejects an out-of-window topic start unless partial_start is explicit", () => {
    const range = topic(1, 3);
    const withoutMarker = validateTopicSegments([range], rows, rows.slice(2), {
      boundarySeq: 5,
      allowPartialStart: true,
    });
    const withMarker = validateTopicSegments([{ ...range, partial_start: true }], rows, rows.slice(2), {
      boundarySeq: 5,
      allowPartialStart: true,
    });

    expect(withoutMarker).toEqual([]);
    expect(withMarker[0]).toMatchObject({ start_seq: 3, start_at: rows[2].created_at, partial_start: true });
  });

  it("does not promote facts with an unknown confidence as explicit", () => {
    const parsed = extractTopicSegments([
      "summary body",
      "```jarela-topics",
      JSON.stringify([{
        ...topic(1, 2),
        facts: [
          { subject: "valid", content: "verified fact", confidence: "verified" },
          { subject: "invalid", content: "unverified claim", confidence: "probably" },
        ],
      }]),
      "```",
    ].join("\n"));

    expect(parsed.topics[0].facts).toEqual([
      { subject: "valid", content: "verified fact", tags: [], confidence: "verified" },
    ]);
  });
});

describe("summarizeTranscript", () => {
  it("returns empty for empty transcript", async () => {
    const provider = {
      chat: vi.fn(),
    } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "m", {}, "   ");
    expect(out).toBe("");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("streams chunks and trims final summary", async () => {
    const chat = vi.fn(async (_modelId: string, _messages: ProviderMessage[], _params: ProviderParams) => {
      async function* gen() {
        yield "  first";
        yield " second  ";
      }
      return { stream: gen() };
    });

    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", { max_tokens: 100 }, "conversation");
    expect(out).toBe("first second");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("sends summarizer system prompt and transcript payload", async () => {
    const chat = vi.fn(async (_modelId: string, messages: ProviderMessage[], _params: ProviderParams) => {
      expect(messages[0].role).toBe("system");
      expect(String(messages[0].content)).toContain("compressing a chat transcript");
      expect(String(messages[0].content)).toContain("Artefacts (verbatim)");
      expect(messages[1].role).toBe("user");
      expect(String(messages[1].content)).toContain("Conversation to summarize");
      expect(String(messages[1].content)).toContain("alpha beta");
      async function* gen() {
        yield "ok";
      }
      return { stream: gen() };
    });

    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", {}, "alpha beta");
    expect(out).toBe("ok");
  });

  // Silent-mode trigger/watcher/bridge prompts embed a "reply with NO_REPLY"
  // instruction as real transcript content. A summarizer model can mistake
  // that quoted instruction for its own directive and echo the bare
  // sentinel back — this must never be persisted/rendered as a summary.
  it("discards a bare NO_REPLY sentinel echoed by the summarizer", async () => {
    const chat = vi.fn(async () => {
      async function* gen() {
        yield "NO_REPLY";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", {}, "transcript with [SILENT_TASK] directive");
    expect(out).toBe("");
  });

  it("discards a bare NOREPLY variant with surrounding whitespace", async () => {
    const chat = vi.fn(async () => {
      async function* gen() {
        yield "  NoReply  ";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", {}, "transcript");
    expect(out).toBe("");
  });

  it("keeps a real summary that merely mentions NO_REPLY in prose", async () => {
    const chat = vi.fn(async () => {
      async function* gen() {
        yield "## Context\nThe scheduled task replied with NO_REPLY because nothing changed.";
      }
      return { stream: gen() };
    });
    const provider = { chat } as unknown as Pick<ModelProvider, "chat">;
    const out = await summarizeTranscript(provider, "model-x", {}, "transcript");
    expect(out).toContain("NO_REPLY because nothing changed");
  });
});
