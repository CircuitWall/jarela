import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-changetracker-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  recordSeen,
  hasChanged,
  getFingerprint,
  clearKey,
  clearScope,
  listScope,
} = await import("./change-tracker");

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  clearScope("docs");
  clearScope("other");
});

describe("change-tracker (ADR-0025)", () => {
  it("reports changed=true and previous=null on first observation", () => {
    const r = recordSeen("docs", "/foo.md", "hash-a");
    expect(r).toEqual({ changed: true, previous: null });
    expect(getFingerprint("docs", "/foo.md")).toBe("hash-a");
  });

  it("reports changed=false when the fingerprint is unchanged", () => {
    recordSeen("docs", "/foo.md", "hash-a");
    const r = recordSeen("docs", "/foo.md", "hash-a");
    expect(r.changed).toBe(false);
    expect(r.previous).toBe("hash-a");
  });

  it("reports changed=true with the prior fingerprint when it differs", () => {
    recordSeen("docs", "/foo.md", "hash-a");
    const r = recordSeen("docs", "/foo.md", "hash-b");
    expect(r).toEqual({ changed: true, previous: "hash-a" });
    expect(getFingerprint("docs", "/foo.md")).toBe("hash-b");
  });

  it("isolates scopes so the same key in two scopes is tracked independently", () => {
    recordSeen("docs", "/foo.md", "doc-hash");
    recordSeen("other", "/foo.md", "other-hash");
    expect(getFingerprint("docs", "/foo.md")).toBe("doc-hash");
    expect(getFingerprint("other", "/foo.md")).toBe("other-hash");
  });

  it("hasChanged() is a non-mutating probe", () => {
    recordSeen("docs", "/foo.md", "hash-a");
    expect(hasChanged("docs", "/foo.md", "hash-b")).toBe(true);
    // Probe didn't write — a follow-up record still sees the old fingerprint.
    expect(recordSeen("docs", "/foo.md", "hash-b")).toEqual({
      changed: true,
      previous: "hash-a",
    });
  });

  it("clearKey removes one entry", () => {
    recordSeen("docs", "/foo.md", "hash-a");
    recordSeen("docs", "/bar.md", "hash-b");
    expect(clearKey("docs", "/foo.md")).toBe(true);
    expect(getFingerprint("docs", "/foo.md")).toBeNull();
    expect(getFingerprint("docs", "/bar.md")).toBe("hash-b");
  });

  it("clearScope wipes every entry in a scope", () => {
    recordSeen("docs", "/foo.md", "hash-a");
    recordSeen("docs", "/bar.md", "hash-b");
    recordSeen("other", "/baz.md", "hash-c");
    const removed = clearScope("docs");
    expect(removed).toBe(2);
    expect(listScope("docs")).toHaveLength(0);
    expect(getFingerprint("other", "/baz.md")).toBe("hash-c");
  });
});
