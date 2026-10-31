import { mkdtempSync, rmSync, writeFileSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/env/config";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-result-refs-"));
process.env.JARELA_DB_DIR = tmpRoot;

const {
  getToolResultMaxBytes,
  parseToolResultReferenceEnvelope,
  postProcessToolResult,
  readToolResultRef,
  serializeToolResult,
} = await import("./result-refs");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetConfigCache();
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

async function spill(result: unknown, maxBytes = 64) {
  vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", String(maxBytes));
  resetConfigCache();
  const envelope = parseToolResultReferenceEnvelope(await postProcessToolResult("my tool/x", result));
  if (!envelope) throw new Error("expected a reference envelope");
  return envelope;
}

async function readAll(name: string, limit: number) {
  const pages: string[] = [];
  let offset: number | null = 0;
  for (let guard = 0; offset !== null && guard < 10_000; guard++) {
    const page = await readToolResultRef({ name, offset, limit });
    expect(page.ok).toBe(true);
    pages.push(page.result as string);
    offset = page.next_offset as number | null;
  }
  return pages;
}

describe("max inline bytes", () => {
  it("ignores invalid overrides", () => {
    for (const bad of ["0", "-5", "abc", "Infinity"]) {
      vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", bad);
      resetConfigCache();
      expect(getToolResultMaxBytes()).toBe(16 * 1024);
    }
    vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", "100.9");
    resetConfigCache();
    expect(getToolResultMaxBytes()).toBe(100);
  });
});

describe("postProcessToolResult", () => {
  it("passes small results through unchanged", async () => {
    vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", "1000");
    resetConfigCache();
    expect(await postProcessToolResult("t", { a: 1 })).toBe('{"a":1}');
    expect(serializeToolResult(undefined)).toBe("undefined");
  });

  it("prioritizes source search and bounded reads for file spills without changing other result contracts", async () => {
    vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", "64");
    resetConfigCache();
    const payload = JSON.stringify({ content: "Synthetic content\n".repeat(100) });
    const file = parseToolResultReferenceEnvelope(await postProcessToolResult("file_read", payload))!;
    const other = parseToolResultReferenceEnvelope(await postProcessToolResult("synthetic_tool", payload))!;
    expect(file.hint).toContain("Prefer file_grep on the source path");
    expect(file.hint).toContain("file_read with explicit start_line/end_line");
    expect(file.hint).toContain("unless the task requires complete inspection");
    expect(other.hint).not.toContain("Prefer file_grep");
    for (const envelope of [file, other]) {
      expect(envelope.hint).toContain("a small offset/limit only for the needed slice");
      expect(envelope.hint).toContain(envelope.result_ref.name);
      expect(envelope.bytes).toBe(Buffer.byteLength(payload));
      expect(await readToolResultRef({ name: envelope.result_ref.name, limit: 20 }))
        .toMatchObject({ ok: true, result: payload.slice(0, 20) });
    }
  });

  it("measures the limit in bytes, not characters", async () => {
    vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", "10");
    resetConfigCache();
    // 4 characters, 16 bytes.
    const out = await postProcessToolResult("t", "😀😀😀😀");
    expect(parseToolResultReferenceEnvelope(out)?.bytes).toBe(16);
  });

  it("sanitizes the tool name and records the total array length", async () => {
    const envelope = await spill(Array.from({ length: 50 }, (_, i) => ({ i })));
    expect(envelope.result_ref.mimeType).toBe("application/json");
    expect(envelope.total_count).toBe(50);
    expect((envelope.preview as unknown[]).length).toBe(20);
  });

  it("keeps array previews within the preview byte budget when rows are huge", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ i, body: "x".repeat(50_000) }));
    const envelope = await spill(rows);
    expect(envelope.preview_bytes).toBeLessThanOrEqual(4 * 1024);
    expect(typeof envelope.preview).toBe("string");
    expect(Buffer.byteLength(envelope.preview as string)).toBe(envelope.preview_bytes);
    expect(envelope.total_count).toBe(3);
  });

  it("never ends a text preview on half of a surrogate pair", async () => {
    const envelope = await spill("a" + "😀".repeat(3000));
    const preview = envelope.preview as string;
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(4 * 1024);
    expect(preview.isWellFormed()).toBe(true);
  });
});

describe("readToolResultRef", () => {
  it("retrieves the exact emitted reference through the public readback tool without an async key", async () => {
    const { toolResultGetTool, toolResultListTool } = await import("./async-results-tool");
    const body = JSON.stringify({ ok: true, content: "synthetic large file\n".repeat(2000) });
    const envelope = await spill(body);
    expect(envelope.result_ref.name).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(envelope.hint).toContain(envelope.result_ref.name);
    expect(envelope.hint).toContain('result_ref: { name: "');
    expect(envelope.hint).toContain("including its extension, not sha256");
    expect(toolResultGetTool.description).toContain("ambiguous");
    expect(toolResultListTool.description).toContain("Synchronous spilled results");
    const page = JSON.parse(await toolResultGetTool.invoke({
      result_ref: { name: envelope.result_ref.name }, offset: 0, limit: 2000,
    }) as string);
    expect(page).toMatchObject({ ok: true, status: "done", result: body.slice(0, 2000), next_offset: 2000 });
    expect(JSON.parse(await toolResultListTool.invoke({}) as string).count).toBe(0);
  });

  it("resolves a copied content hash to its stored result filename", async () => {
    const envelope = await spill(JSON.stringify({ content: "synthetic ".repeat(100) }));
    const page = await readToolResultRef({ name: envelope.result_ref.sha256!, limit: 20 });
    expect(page).toMatchObject({ ok: true, name: envelope.result_ref.name, status: "done" });
  });

  it.each(["file_read", "memory_search"])("reads a real wrapped %s spill by filename and content hash", async (toolName) => {
    const { tool } = await import("@langchain/core/tools");
    const { z } = await import("zod");
    const { wrapWithWallclock } = await import("./wallclock");
    const { toolResultGetTool } = await import("./async-results-tool");
    vi.stubEnv("JARELA_TOOL_RESULT_MAX_BYTES", "16384");
    resetConfigCache();
    const contents = JSON.stringify({ ok: true, content: `${toolName} synthetic\n`.repeat(5000) });
    const wrapped = wrapWithWallclock(tool(async () => contents, {
      name: toolName, description: "Synthetic shared-spill regression", schema: z.object({}),
    }));
    const envelope = parseToolResultReferenceEnvelope(await wrapped.invoke({}));
    expect(envelope).not.toBeNull();
    for (const name of [envelope!.result_ref.name, envelope!.result_ref.sha256!]) {
      const page = JSON.parse(await wrapWithWallclock(toolResultGetTool).invoke({
        result_ref: { name }, offset: 5000, limit: 2000,
      }) as string);
      expect(page).toMatchObject({
        ok: true, status: "done", result: contents.slice(5000, 7000), next_offset: 7000,
      });
    }
  });

  it("supports text hashes without guessing when JSON and text names both exist", async () => {
    const { fileAbsPath } = await import("@/lib/files");
    const envelope = await spill("synthetic text ".repeat(100));
    expect(await readToolResultRef({ name: envelope.result_ref.sha256!, limit: 9 }))
      .toMatchObject({ ok: true, name: envelope.result_ref.name, result: "synthetic" });
    writeFileSync(fileAbsPath(`${envelope.result_ref.sha256}.json`)!, "{}");
    expect(await readToolResultRef({ name: envelope.result_ref.sha256! }))
      .toMatchObject({ ok: false, status: "ambiguous", error: expect.stringContaining("full result_ref.name") });
    expect(await readToolResultRef({ name: envelope.result_ref.name, limit: 9 }))
      .toMatchObject({ ok: true, result: "synthetic" });
  });

  it("reports real I/O failures distinctly from an unknown or expired reference", async () => {
    const envelope = await spill("synthetic denied ".repeat(100));
    vi.spyOn(fsp, "open").mockRejectedValueOnce(Object.assign(new Error("Synthetic access denied"), { code: "EACCES" }));
    expect(await readToolResultRef({ name: envelope.result_ref.name }))
      .toMatchObject({ ok: false, status: "error", error: expect.stringContaining("Synthetic access denied") });
  });

  it("pages multi-byte text without corrupting characters at page edges", async () => {
    const text = "héllo wörld — 日本語のテキスト 😀🎉 ".repeat(4);
    const envelope = await spill(text);
    for (const limit of [1, 2, 3, 5, 7, 64]) {
      const pages = await readAll(envelope.result_ref.name, limit);
      expect(pages.join("")).toBe(text);
      expect(pages.every((p) => !p.includes("\uFFFD"))).toBe(true);
    }
  });

  it("realigns a caller offset that lands inside a character", async () => {
    const envelope = await spill("€".repeat(100)); // 3 bytes each
    const page = await readToolResultRef({ name: envelope.result_ref.name, offset: 4, limit: 6 });
    expect(page).toMatchObject({ offset: 3, result: "€€", next_offset: 9 });
  });

  it("returns an empty final page for offsets past the end", async () => {
    const envelope = await spill("z".repeat(200));
    const page = await readToolResultRef({ name: envelope.result_ref.name, offset: 10_000 });
    expect(page).toMatchObject({ ok: true, result: "", next_offset: null, done: true });
  });

  it("clamps negative and fractional offsets and limits", async () => {
    const envelope = await spill("abcdefghij".repeat(10));
    const page = await readToolResultRef({ name: envelope.result_ref.name, offset: -3.7, limit: 2.9 });
    expect(page).toMatchObject({ offset: 0, limit: 2, result: "ab", next_offset: 2 });
  });

  it("rejects path traversal and unknown refs without throwing", async () => {
    expect(await readToolResultRef({ name: "../secrets.json" })).toMatchObject({ ok: false, error: "unsafe result_ref name" });
    expect(await readToolResultRef({ name: "deadbeef.json" })).toMatchObject({ ok: false, status: "unknown" });
  });
});

describe("parseToolResultReferenceEnvelope", () => {
  it("rejects look-alike payloads", () => {
    expect(parseToolResultReferenceEnvelope("not json")).toBeNull();
    expect(parseToolResultReferenceEnvelope({ ok: true, truncated: true, bytes: 1 })).toBeNull();
    expect(parseToolResultReferenceEnvelope({ ok: true, truncated: "yes", bytes: 1, result_ref: { name: "a" } })).toBeNull();
    expect(parseToolResultReferenceEnvelope('{"ok":true,"truncated":true,"bytes":"1","result_ref":{"name":"a"}}')).toBeNull();
    expect(parseToolResultReferenceEnvelope(null)).toBeNull();
  });
});
