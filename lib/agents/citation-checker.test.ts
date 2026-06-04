import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-citations-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  extractCitedLinks,
  extractSourcesFromEvents,
  extractVisitedSources,
  normalizeSource,
  parseCitationVerdict,
} = await import("./citation-checker");
const {
  createThread,
  deleteThread,
  listThreads,
} = await import("@/lib/stores/threads");
const { getDb } = await import("@/lib/db");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("normalizeSource", () => {
  it("lowercases + strips query/fragment + trailing slash on URLs", () => {
    expect(normalizeSource("HTTPS://Example.com/Docs/?x=1#a")).toBe("https://example.com/docs");
    expect(normalizeSource("https://a.io/p/")).toBe("https://a.io/p");
  });

  it("normalises backslashes and trailing slashes on paths", () => {
    expect(normalizeSource("docs\\Adr\\README.md")).toBe("docs/adr/readme.md");
    expect(normalizeSource("lib/agents/")).toBe("lib/agents");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeSource("")).toBe("");
    expect(normalizeSource("   ")).toBe("");
  });
});

describe("extractCitedLinks", () => {
  it("returns [] for empty input", () => {
    expect(extractCitedLinks("")).toEqual([]);
  });

  it("pulls every markdown link target", () => {
    const text = "See [a](https://x.io/a) and [b](docs/b.md) plus [c](https://x.io/c).";
    expect(extractCitedLinks(text)).toEqual(["https://x.io/a", "docs/b.md", "https://x.io/c"]);
  });

  it("dedupes duplicates", () => {
    expect(extractCitedLinks("[x](u) again [x](u)")).toEqual(["u"]);
  });

  it("ignores reference-style and bare URLs (only honors inline [..](..) links)", () => {
    const text = "Bare https://x.io/raw and reference [x][1].";
    expect(extractCitedLinks(text)).toEqual([]);
  });
});

describe("extractSourcesFromEvents", () => {
  it("extracts URLs and paths from source-producing tool calls", () => {
    const events = [
      { id: "1", phase: "call" as const, name: "file_read", payload: { path: "lib/x.ts" } },
      { id: "2", phase: "result" as const, name: "web_search", payload: { results: [
        { url: "https://a.io/p1", title: "p1" },
        { url: "https://b.io/p2", title: "p2" },
      ]}},
    ];
    const got = extractSourcesFromEvents(events);
    expect(got.has("lib/x.ts")).toBe(true);
    expect(got.has("https://a.io/p1")).toBe(true);
    expect(got.has("https://b.io/p2")).toBe(true);
  });

  it("ignores tools that don't produce sources (e.g. memory_read)", () => {
    const events = [
      { id: "1", phase: "result" as const, name: "memory_read", payload: { key: "fav-color", value: "blue" } },
    ];
    expect(extractSourcesFromEvents(events).size).toBe(0);
  });

  it("returns empty set for empty input", () => {
    expect(extractSourcesFromEvents([]).size).toBe(0);
  });
});

describe("extractVisitedSources", () => {
  beforeEach(() => {
    for (const t of listThreads(1000, 0)) deleteThread(t.thread_id);
  });

  it("unions tool events across every assistant turn in the thread with fresh events", () => {
    const t = createThread("agent-c");
    const db = getDb();
    db.prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events) VALUES (?,?,?,?,?,?)")
      .run("m1", t.thread_id, "assistant", "older", "2026-06-01T00:00:00Z",
        JSON.stringify([{ id: "a", phase: "call", name: "file_read", payload: { path: "docs/old.md" } }]));
    db.prepare("UPDATE threads SET message_count=1 WHERE thread_id=?").run(t.thread_id);
    const fresh = [{ id: "b", phase: "call" as const, name: "web_search", payload: { query: "x", results: [{ url: "https://new.io/p" }] } }];
    const got = extractVisitedSources(t.thread_id, fresh);
    expect(got.has("docs/old.md")).toBe(true);
    expect(got.has("https://new.io/p")).toBe(true);
  });

  it("tolerates malformed historical tool_events JSON", () => {
    const t = createThread("agent-c");
    const db = getDb();
    db.prepare("INSERT INTO messages (msg_id,thread_id,role,content,created_at,tool_events) VALUES (?,?,?,?,?,?)")
      .run("m1", t.thread_id, "assistant", "older", "2026-06-01T00:00:00Z", "{not json");
    expect(() => extractVisitedSources(t.thread_id, [])).not.toThrow();
    expect(extractVisitedSources(t.thread_id, []).size).toBe(0);
  });
});

describe("parseCitationVerdict", () => {
  it("returns null for empty input", () => {
    expect(parseCitationVerdict("")).toBeNull();
  });

  it("parses a clean JSON verdict and clamps overlong fields", () => {
    const longText = "x".repeat(300);
    const json = JSON.stringify({ claims: [{ text: longText, link: "https://a", verified: true, reason: longText }] });
    const out = parseCitationVerdict(json);
    expect(out).toHaveLength(1);
    expect(out![0].text.length).toBeLessThanOrEqual(200);
    expect(out![0].reason.length).toBeLessThanOrEqual(200);
    expect(out![0].link).toBe("https://a");
  });

  it("strips a markdown code fence wrapping", () => {
    const wrapped = '```json\n{"claims":[{"text":"a","link":null,"verified":false,"reason":"no link"}]}\n```';
    const out = parseCitationVerdict(wrapped);
    expect(out).toEqual([{ text: "a", link: null, verified: false, reason: "no link" }]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseCitationVerdict("{not json")).toBeNull();
  });

  it("returns null when the top-level shape doesn't have claims[]", () => {
    expect(parseCitationVerdict('{"foo":"bar"}')).toBeNull();
  });

  it("filters out claim entries that don't have a text field", () => {
    const out = parseCitationVerdict('{"claims":[{"text":""},{"link":"x"},{"text":"keep","verified":true,"link":null,"reason":"ok"}]}');
    expect(out).toEqual([{ text: "keep", link: null, verified: true, reason: "ok" }]);
  });
});
