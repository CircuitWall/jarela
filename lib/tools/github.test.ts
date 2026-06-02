import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process; the integrations store opens the DB on
// first import. Set the env var before importing the module under test.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-github-"));
process.env.JARELA_DB_DIR = tmpRoot;
process.env.GITHUB_TOKEN = "test-pat";
process.on("exit", () => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const {
  truncate,
  decodeContentsBlob,
  githubCreatePullTool,
  githubMergePullTool,
  githubCreateReviewTool,
} = await import("./github");

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

function installFetch() {
  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init: init ?? {} });
    const body = JSON.stringify(nextResponse.body);
    return new Response(body, {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  };
  vi.stubGlobal("fetch", fake);
}

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("truncate", () => {
  it("returns the input untouched when below the cap", () => {
    expect(truncate("hello", 10)).toEqual({ text: "hello", truncated: false });
  });
  it("returns the input untouched when exactly at the cap", () => {
    expect(truncate("abcde", 5)).toEqual({ text: "abcde", truncated: false });
  });
  it("slices and flags truncation when over the cap", () => {
    expect(truncate("abcdef", 5)).toEqual({ text: "abcde", truncated: true });
  });
  it("handles empty strings", () => {
    expect(truncate("", 5)).toEqual({ text: "", truncated: false });
  });
});

describe("decodeContentsBlob", () => {
  it("decodes base64 text", () => {
    const r = decodeContentsBlob(Buffer.from("hello world").toString("base64"), "base64");
    expect(r.binary).toBe(false);
    expect(r.text).toBe("hello world");
    expect(r.size_bytes).toBe(11);
  });
  it("flags binary content with NUL bytes", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const r = decodeContentsBlob(buf.toString("base64"), "base64");
    expect(r.binary).toBe(true);
    expect(r.text).toBeUndefined();
    expect(r.size_bytes).toBe(5);
  });
  it("returns empty payload for empty content", () => {
    expect(decodeContentsBlob("", "base64")).toEqual({ binary: false, text: "", size_bytes: 0 });
  });
  it("strips whitespace inside the base64 envelope", () => {
    const b64 = Buffer.from("hi").toString("base64");
    const padded = b64.slice(0, 2) + "\n" + b64.slice(2);
    const r = decodeContentsBlob(padded, "base64");
    expect(r.text).toBe("hi");
  });
});

describe("github_create_pull", () => {
  it("POSTs to /pulls with the expected body and returns the success envelope", async () => {
    nextResponse = {
      status: 201,
      body: { number: 42, html_url: "https://github.com/o/r/pull/42", draft: false },
    };
    const out = await githubCreatePullTool.invoke({
      owner: "o",
      repo: "r",
      title: "feat: x",
      head: "feature/x",
      base: "main",
      body: "describes x",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      title: "feat: x",
      head: "feature/x",
      base: "main",
      body: "describes x",
    });
    expect(JSON.parse(out)).toEqual({
      ok: true, number: 42, draft: false, url: "https://github.com/o/r/pull/42",
    });
  });

  it("propagates GitHub error envelopes", async () => {
    nextResponse = { status: 422, body: { message: "no diff" } };
    const out = await githubCreatePullTool.invoke({
      owner: "o", repo: "r", title: "x", head: "f", base: "main",
    });
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain("422");
  });
});

describe("github_merge_pull", () => {
  it("PUTs the merge endpoint with method, sha guard, and message body", async () => {
    nextResponse = { status: 200, body: { merged: true, sha: "abc123", message: "Pull request merged" } };
    const out = await githubMergePullTool.invoke({
      owner: "o", repo: "r", number: 7, method: "squash", sha: "deadbeef",
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/7/merge");
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      merge_method: "squash",
      sha: "deadbeef",
    });
    expect(JSON.parse(out)).toEqual({
      ok: true, merged_sha: "abc123", message: "Pull request merged",
    });
  });

  it("reports ok:false when GitHub responds with merged:false", async () => {
    nextResponse = { status: 200, body: { merged: false, message: "PR not mergeable" } };
    const out = await githubMergePullTool.invoke({ owner: "o", repo: "r", number: 7 });
    expect(JSON.parse(out)).toMatchObject({ ok: false });
  });
});

describe("github_create_review", () => {
  it("POSTs APPROVE without requiring a body", async () => {
    nextResponse = {
      status: 200,
      body: { id: 99, state: "APPROVED", html_url: "https://github.com/o/r/pull/7#pullrequestreview-99" },
    };
    const out = await githubCreateReviewTool.invoke({
      owner: "o", repo: "r", number: 7, event: "APPROVE",
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/7/reviews");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ event: "APPROVE" });
    expect(JSON.parse(out)).toMatchObject({ ok: true, review_id: 99, state: "APPROVED" });
  });

  it("rejects REQUEST_CHANGES without a body before hitting the network", async () => {
    const out = await githubCreateReviewTool.invoke({
      owner: "o", repo: "r", number: 7, event: "REQUEST_CHANGES",
    });
    expect(calls).toHaveLength(0);
    expect(JSON.parse(out).error).toMatch(/REQUEST_CHANGES/);
  });
});

describe("ghFetch transport-error envelope", () => {
  // See atlassian.test.ts: same root cause and same fix shape — transport
  // failures now return `{error, url}` instead of propagating as a throw.
  it("returns {error, url} envelope when fetch throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const out = await githubCreateReviewTool.invoke({
      owner: "o", repo: "r", number: 7, event: "APPROVE",
    });
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/GitHub fetch threw: fetch failed/);
    expect(parsed.url).toContain("/repos/o/r/pulls/7/reviews");
  });
});
