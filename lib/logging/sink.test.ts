import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installConsolePatch,
  recentEntries,
  subscribe,
  _resetLogSink,
} from "./sink";

// The console patch is installed once per process via a Symbol guard.
// Tests share that singleton — each `beforeEach` clears the ring + subs,
// but the patched `console.*` methods stay patched for the whole run.

describe("log sink — capture", () => {
  beforeEach(() => {
    _resetLogSink();
    installConsolePatch();
  });

  it("captures console.info into the ring", () => {
    console.info("hello", "world");
    const entries = recentEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: "info", text: "hello world" });
    expect(entries[0].seq).toBeGreaterThan(0);
  });

  it("captures all four levels", () => {
    console.log("a");
    console.info("b");
    console.warn("c");
    console.error("d");
    const entries = recentEntries();
    expect(entries.map((e) => e.level)).toEqual(["log", "info", "warn", "error"]);
    expect(entries.map((e) => e.text)).toEqual(["a", "b", "c", "d"]);
  });

  it("stringifies non-string args", () => {
    console.info({ a: 1, b: "x" }, 42, true);
    const entries = recentEntries();
    expect(entries[0].text).toContain('"a":1');
    expect(entries[0].text).toContain("42");
    expect(entries[0].text).toContain("true");
  });

  it("flattens errors via .stack", () => {
    const err = new Error("boom");
    console.error("caught", err);
    const entries = recentEntries();
    expect(entries[0].text).toContain("caught");
    expect(entries[0].text).toMatch(/Error: boom/);
  });

  it("preserves stdout/stderr — original console methods still fire", () => {
    // Hard to test directly without spying on Node's stdout, but we can
    // verify the ring + a manual spy receive the same call. The patch's
    // contract is "invoke original first, push to ring second."
    const spy = vi.fn();
    const original = console.info;
    // Wrap the patched method one more time so we can observe it firing.
    console.info = (...args: unknown[]) => {
      spy(...args);
      original(...args);
    };
    try {
      console.info("trace");
      expect(spy).toHaveBeenCalledWith("trace");
      // Note: this test file's wrapper bypasses the patch since we
      // overwrote console.info above. Restore + re-test the ring path.
    } finally {
      console.info = original;
    }
    _resetLogSink();
    console.info("trace2");
    expect(recentEntries()[0].text).toBe("trace2");
  });
});

describe("log sink — redaction", () => {
  beforeEach(() => {
    _resetLogSink();
    installConsolePatch();
  });

  it("redacts Authorization Bearer tokens", () => {
    console.error("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG");
    const t = recentEntries()[0].text;
    expect(t).toContain("[redacted]");
    expect(t).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts api_key in URL query", () => {
    console.info("https://api.example.com/?api_key=ABCDEF1234567890");
    const t = recentEntries()[0].text;
    expect(t).toContain("[redacted]");
    expect(t).not.toContain("ABCDEF1234567890");
  });

  it("redacts known token shapes (sk-, ghp_, gho_)", () => {
    console.info("calling with sk-aaaaaaaaaaaaaaaaaaaa"); // jarela-secret-ok
    expect(recentEntries()[0].text).toContain("[redacted-key]");
    _resetLogSink();
    console.info("token=ghp_bbbbbbbbbbbbbbbbbbbb"); // jarela-secret-ok
    expect(recentEntries()[0].text).toContain("[redacted-token]");
  });

  it("does not over-redact short identifiers", () => {
    console.info("agent_id=alice token=12345");
    // Both fragments are too short for our token patterns; should pass
    // through unchanged.
    expect(recentEntries()[0].text).toContain("alice");
    expect(recentEntries()[0].text).toContain("12345");
  });
});

describe("log sink — ring + subscribe", () => {
  beforeEach(() => {
    _resetLogSink();
    installConsolePatch();
  });

  it("monotonic seq across the entire process", () => {
    console.info("a");
    const seqA = recentEntries()[0].seq;
    console.info("b");
    const seqB = recentEntries()[1].seq;
    expect(seqB).toBe(seqA + 1);
  });

  it("recentEntries(N) returns the last N", () => {
    for (let i = 0; i < 10; i += 1) console.info(`line ${i}`);
    expect(recentEntries(3).map((e) => e.text)).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("subscribers receive new entries; not the historical ring", () => {
    console.info("before");
    const seen: string[] = [];
    const unsub = subscribe((e) => { seen.push(e.text); });
    try {
      console.info("after");
      expect(seen).toEqual(["after"]);
    } finally {
      unsub();
    }
    console.info("post-unsub");
    expect(seen).toEqual(["after"]);
  });

  it("subscriber throw doesn't kill other subscribers", () => {
    const seenA: string[] = [];
    const seenC: string[] = [];
    subscribe(() => { throw new Error("bad subscriber"); });
    subscribe((e) => { seenA.push(e.text); });
    subscribe((e) => { seenC.push(e.text); });
    console.info("hello");
    expect(seenA).toEqual(["hello"]);
    expect(seenC).toEqual(["hello"]);
  });
});

describe("log sink — idempotent install", () => {
  it("installing twice does not double-capture", () => {
    _resetLogSink();
    installConsolePatch();
    installConsolePatch();
    installConsolePatch();
    console.info("once");
    expect(recentEntries()).toHaveLength(1);
  });
});
