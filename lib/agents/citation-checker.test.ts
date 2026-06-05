import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-citations-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  buildSourceManifest,
  extractCitedLinks,
  extractCitedMarkers,
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

  it("parses the marker field when present", () => {
    const json = '{"claims":[{"text":"a fact","marker":3,"verified":true,"reason":"cited"}]}';
    const out = parseCitationVerdict(json);
    expect(out).toEqual([{ text: "a fact", marker: 3, link: null, verified: true, reason: "cited" }]);
  });

  it("coerces a missing/null marker to null", () => {
    const json = '{"claims":[{"text":"x","verified":false,"reason":"no marker"}]}';
    expect(parseCitationVerdict(json)).toEqual([{ text: "x", marker: null, link: null, verified: false, reason: "no marker" }]);
  });

  it("drops a non-positive or non-finite marker", () => {
    const json = '{"claims":[{"text":"a","marker":0,"verified":false,"reason":""},{"text":"b","marker":-2,"verified":false,"reason":""},{"text":"c","marker":"3","verified":false,"reason":""}]}';
    const out = parseCitationVerdict(json);
    expect(out!.map((c) => c.marker)).toEqual([null, null, null]);
  });

  it("strips a markdown code fence wrapping", () => {
    const wrapped = '```json\n{"claims":[{"text":"a","link":null,"verified":false,"reason":"no link"}]}\n```';
    const out = parseCitationVerdict(wrapped);
    expect(out).toEqual([{ text: "a", marker: null, link: null, verified: false, reason: "no link" }]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseCitationVerdict("{not json")).toBeNull();
  });

  it("returns null when the top-level shape doesn't have claims[]", () => {
    expect(parseCitationVerdict('{"foo":"bar"}')).toBeNull();
  });

  it("filters out claim entries that don't have a text field", () => {
    const out = parseCitationVerdict('{"claims":[{"text":""},{"link":"x"},{"text":"keep","verified":true,"link":null,"reason":"ok"}]}');
    expect(out).toEqual([{ text: "keep", marker: null, link: null, verified: true, reason: "ok" }]);
  });
});

describe("extractCitedMarkers", () => {
  it("returns [] for empty input", () => {
    expect(extractCitedMarkers("")).toEqual([]);
  });

  it("pulls every numeric marker [N] in first-seen order", () => {
    expect(extractCitedMarkers("see [1] then [3] and again [1] plus [12].")).toEqual([1, 3, 12]);
  });

  it("ignores reference-link tails like [label][1]", () => {
    expect(extractCitedMarkers("a [link text][1] not a citation marker")).toEqual([]);
  });

  it("ignores non-numeric brackets like [x] or [v2]", () => {
    expect(extractCitedMarkers("see [x] or [v2] but [4] counts")).toEqual([4]);
  });

  it("ignores zero markers (1-indexed manifest only)", () => {
    expect(extractCitedMarkers("placeholder [0] should be skipped, [1] counts")).toEqual([1]);
  });
});

describe("buildSourceManifest", () => {
  it("returns [] when max is 0 or visited set is empty", () => {
    expect(buildSourceManifest(new Set(["a"]), 0)).toEqual([]);
    expect(buildSourceManifest(new Set(), 50)).toEqual([]);
  });

  it("numbers entries 1..N preserving insertion order", () => {
    const set = new Set(["docs/a.md", "docs/b.md", "https://x.io/p"]);
    const out = buildSourceManifest(set, 50);
    expect(out).toEqual([
      { n: 1, label: "docs/a.md", href: "docs/a.md" },
      { n: 2, label: "docs/b.md", href: "docs/b.md" },
      { n: 3, label: "x.io/p", href: "https://x.io/p" },
    ]);
  });

  it("keeps the most-recent N entries when visited > max", () => {
    const set = new Set(["a", "b", "c", "d", "e"]);
    const out = buildSourceManifest(set, 3);
    expect(out.map((e) => e.href)).toEqual(["c", "d", "e"]);
    // Re-numbered 1..3, not 3..5 — the manifest the agent sees is always 1-indexed.
    expect(out.map((e) => e.n)).toEqual([1, 2, 3]);
  });

  it("derives a hostname+path label for URLs and uses the raw path for files", () => {
    const out = buildSourceManifest(new Set(["https://example.com/docs/x/"]), 50);
    expect(out[0].label).toBe("example.com/docs/x");
    expect(out[0].href).toBe("https://example.com/docs/x/");
  });
});
