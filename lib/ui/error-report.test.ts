import { describe, it, expect } from "vitest";
import {
  buildIssueUrl,
  formatReport,
  stringifyError,
  type ReportEnv,
} from "./error-report";

const ENV: ReportEnv = {
  appVersion: "0.5.1",
  userAgent: "Mozilla/5.0 (test) AppleWebKit/537",
  url: "/",
  ts: "2026-05-27T14:23:11.000Z",
};

// ── stringifyError ──────────────────────────────────────────────────────────

describe("stringifyError", () => {
  it("returns Error.stack when present", () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n    at thing (file.ts:1:1)";
    expect(stringifyError(e)).toBe(e.stack);
  });

  it("falls back to message when stack is missing", () => {
    const e = new Error("just message");
    delete (e as { stack?: string }).stack;
    expect(stringifyError(e)).toBe("just message");
  });

  it("passes strings through verbatim", () => {
    expect(stringifyError("plain string")).toBe("plain string");
  });

  it("JSON-stringifies plain objects", () => {
    expect(stringifyError({ code: 500, msg: "oops" })).toContain('"code": 500');
  });

  it("handles null/undefined without throwing", () => {
    expect(stringifyError(undefined)).toBe("(no error provided)");
    expect(stringifyError(null)).toBe("(no error provided)");
  });

  it("survives circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    // Falls back to String() rather than throwing.
    expect(() => stringifyError(obj)).not.toThrow();
    expect(typeof stringifyError(obj)).toBe("string");
  });
});

// ── formatReport ────────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("renders all sections in order with the expected headings", () => {
    const out = formatReport(
      {
        title: "Couldn't toggle MCP server",
        summary: "The toggle endpoint returned 500.",
        error: new Error("HTTP 500: ECONNRESET"),
        context: { panel: "mcp", action: "toggle", server: "github" },
      },
      ENV,
    );
    expect(out.title).toBe("Couldn't toggle MCP server");
    expect(out.body).toMatch(/^\*\*What failed:\*\* The toggle endpoint returned 500\./);
    expect(out.body).toContain("**Error:**");
    expect(out.body).toContain("HTTP 500: ECONNRESET");
    expect(out.body).toContain("**Context:**");
    expect(out.body).toContain("- panel: mcp");
    expect(out.body).toContain("- action: toggle");
    expect(out.body).toContain("- server: github");
    expect(out.body).toContain("**Environment:**");
    expect(out.body).toContain("- App version: 0.5.1");
    expect(out.body).toContain("- User agent: Mozilla/5.0 (test) AppleWebKit/537");
    expect(out.body).toContain("- URL: /");
    expect(out.body).toContain("- Timestamp: 2026-05-27T14:23:11.000Z");
    expect(out.body).toMatch(/<!-- Anything else .*/);
  });

  it("uses title as summary when summary is omitted", () => {
    const out = formatReport(
      { title: "Save failed", error: "x" },
      ENV,
    );
    expect(out.body.startsWith("**What failed:** Save failed\n\n")).toBe(true);
  });

  it("omits the Context section entirely when context is empty/undefined", () => {
    const out = formatReport({ title: "T", error: "e" }, ENV);
    expect(out.body).not.toContain("**Context:**");
    const out2 = formatReport({ title: "T", error: "e", context: {} }, ENV);
    expect(out2.body).not.toContain("**Context:**");
  });

  it("renders context object values via JSON", () => {
    const out = formatReport(
      { title: "T", error: "e", context: { ids: ["a", "b"] } },
      ENV,
    );
    expect(out.body).toContain('- ids: ["a","b"]');
  });

  it("handles error: undefined and string-only errors without throwing", () => {
    expect(() => formatReport({ title: "T", error: undefined }, ENV)).not.toThrow();
    expect(() => formatReport({ title: "T", error: "raw string" }, ENV)).not.toThrow();
    const out = formatReport({ title: "T", error: "raw string" }, ENV);
    expect(out.body).toContain("raw string");
  });
});

// ── buildIssueUrl ───────────────────────────────────────────────────────────

describe("buildIssueUrl", () => {
  it("points at CircuitWall/jarela's new-issue endpoint with user-report label", () => {
    const url = buildIssueUrl({ title: "x", body: "y" });
    expect(url.startsWith("https://github.com/CircuitWall/jarela/issues/new?")).toBe(true);
    expect(url).toContain("labels=user-report");
  });

  it("percent-encodes & + # newline in title and body", () => {
    const url = buildIssueUrl({
      title: "AT&T + # crash",
      body: "line one\nline two & more",
    });
    // URLSearchParams uses + for spaces and percent-encodes everything else
    // safely. Just confirm the round-trip survives.
    const u = new URL(url);
    expect(u.searchParams.get("title")).toBe("AT&T + # crash");
    expect(u.searchParams.get("body")).toBe("line one\nline two & more");
  });

  it("truncates oversized bodies with a clipboard-fallback footer", () => {
    const huge = "x".repeat(20_000);
    const url = buildIssueUrl({ title: "Big", body: huge });
    const u = new URL(url);
    const body = u.searchParams.get("body")!;
    expect(body.length).toBeLessThan(huge.length);
    expect(body).toMatch(/report truncated.*clipboard/);
  });

  it("does NOT truncate bodies under the cap", () => {
    const small = "small body";
    const url = buildIssueUrl({ title: "T", body: small });
    expect(new URL(url).searchParams.get("body")).toBe(small);
  });
});
