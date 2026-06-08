import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "jarela-bridge-att-"));
process.env.JARELA_DB_DIR = tmpRoot;

// Imported lazily so the JARELA_DB_DIR override above is in place before
// getDataDir() caches its result.
const {
  saveBridgeAttachment,
  pruneBridgeAttachments,
  shouldInline,
  bridgeAttachmentsRoot,
  DEFAULT_INLINE_LIMIT_BYTES,
  BRIDGE_ATTACHMENTS_DIRNAME,
  INLINE_MIME_PREFIXES,
} = await import("./attachment-store");

beforeEach(() => {
  // Clear any prior attachments between tests.
  try {
    rmSync(bridgeAttachmentsRoot(), { recursive: true, force: true });
  } catch { /* */ }
});

afterEach(() => {
  try {
    rmSync(bridgeAttachmentsRoot(), { recursive: true, force: true });
  } catch { /* */ }
});

describe("shouldInline", () => {
  it("inlines small images", () => {
    expect(shouldInline("image/jpeg", 64_000)).toBe(true);
    expect(shouldInline("image/webp", DEFAULT_INLINE_LIMIT_BYTES)).toBe(true);
    expect(shouldInline("image/png", 0)).toBe(true);
  });

  it("spills oversized images", () => {
    expect(shouldInline("image/png", DEFAULT_INLINE_LIMIT_BYTES + 1)).toBe(false);
  });

  it("spills non-image media regardless of size", () => {
    expect(shouldInline("application/pdf", 1024)).toBe(false);
    expect(shouldInline("audio/ogg", 1024)).toBe(false);
    expect(shouldInline("video/mp4", 1024)).toBe(false);
    expect(shouldInline("text/plain", 100)).toBe(false);
  });

  it("honours a caller-supplied limit override", () => {
    expect(shouldInline("image/jpeg", 5_000, 10_000)).toBe(true);
    expect(shouldInline("image/jpeg", 15_000, 10_000)).toBe(false);
  });

  it("only inlines media types whose prefix is in the allowlist", () => {
    // Sanity-pin the policy so a future change here is intentional.
    expect(INLINE_MIME_PREFIXES).toEqual(["image/"]);
  });
});

describe("saveBridgeAttachment", () => {
  it("writes the buffer under <data>/bridge-attachments/<bridge>/<date>/", async () => {
    const buf = Buffer.from("hello world");
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "hello.txt",
      media_type: "text/plain",
      message_id: "msg-1",
      buffer: buf,
    });
    expect(existsSync(saved.abs_path)).toBe(true);
    expect(saved.size).toBe(buf.length);
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = await readFile(saved.abs_path);
    expect(onDisk.equals(buf)).toBe(true);
    // Path must live under the bridge-specific subtree.
    expect(saved.abs_path.startsWith(path.join(bridgeAttachmentsRoot(), "b1"))).toBe(true);
  });

  it("sha256 matches an independent hash of the buffer", async () => {
    const buf = crypto.randomBytes(4096);
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "rand.bin",
      media_type: "application/octet-stream",
      buffer: buf,
    });
    const expected = crypto.createHash("sha256").update(buf).digest("hex");
    expect(saved.sha256).toBe(expected);
  });

  it("uses YYYY-MM-DD format for the day directory", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "f.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.from("x"),
    });
    const dayDir = path.basename(path.dirname(saved.abs_path));
    expect(dayDir).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("sanitises path separators and control chars in filenames", async () => {
    const buf = Buffer.from("payload");
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "../../etc/passwd",
      media_type: "text/plain",
      message_id: "msg-evil",
      buffer: buf,
    });
    const rel = path.relative(bridgeAttachmentsRoot(), saved.abs_path);
    expect(rel.startsWith("..")).toBe(false);
    expect(path.basename(saved.abs_path)).not.toContain("/");
    expect(path.basename(saved.abs_path)).not.toContain("\\");
    // The "passwd" leaf survives but it's just a filename, not a traversal.
    expect(saved.abs_path.includes("etc" + path.sep + "passwd")).toBe(false);
  });

  it("strips Windows-hostile filename characters (* ? \" < > | :)", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: 'a*b?c"d<e>f|g:h.txt',
      media_type: "text/plain",
      message_id: "m",
      buffer: Buffer.from("x"),
    });
    const base = path.basename(saved.abs_path);
    expect(base).not.toMatch(/[*?"<>|:]/);
  });

  it("strips ASCII control characters from filenames", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "a\x00b\x07c\x1f.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.from("x"),
    });
    const base = path.basename(saved.abs_path);
    // No control chars should leak through.
    expect(/[\x00-\x1f]/.test(base)).toBe(false);
  });

  it("truncates very long filenames while preserving the extension", async () => {
    const longName = "x".repeat(500) + ".pdf";
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: longName,
      media_type: "application/pdf",
      message_id: "m",
      buffer: Buffer.from("x"),
    });
    const base = path.basename(saved.abs_path);
    // <id>-<truncated>; <truncated> portion is ≤ 80 chars.
    const truncated = base.replace(/^m-/, "");
    expect(truncated.length).toBeLessThanOrEqual(80);
    expect(truncated.endsWith(".pdf")).toBe(true);
  });

  it("sanitises a hostile bridge_id", async () => {
    const buf = Buffer.from("x");
    const saved = await saveBridgeAttachment({
      bridge_id: "../etc",
      filename: "f.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: buf,
    });
    const rel = path.relative(bridgeAttachmentsRoot(), saved.abs_path);
    expect(rel.startsWith("..")).toBe(false);
    // The traversal segment "../etc" collapses to "___etc" (3 chars replaced).
    const bridgeDir = rel.split(path.sep)[0];
    expect(bridgeDir).not.toContain("..");
    expect(bridgeDir).not.toContain("/");
  });

  it("sanitises a hostile message_id (path traversal characters)", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "f.bin",
      media_type: "application/octet-stream",
      message_id: "../../escape",
      buffer: Buffer.from("x"),
    });
    const rel = path.relative(bridgeAttachmentsRoot(), saved.abs_path);
    expect(rel.startsWith("..")).toBe(false);
  });

  it("generates a filename when none is given", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: null,
      media_type: "application/octet-stream",
      buffer: Buffer.from("x"),
    });
    expect(path.basename(saved.abs_path)).toMatch(/attachment$/);
  });

  it("generates a filename when one is whitespace-only", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "   \t\n  ",
      media_type: "application/octet-stream",
      buffer: Buffer.from("x"),
    });
    expect(path.basename(saved.abs_path)).toMatch(/attachment$/);
  });

  it("generates a random id when message_id is missing", async () => {
    const a = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "f.bin",
      media_type: "application/octet-stream",
      buffer: Buffer.from("a"),
    });
    const b = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "f.bin",
      media_type: "application/octet-stream",
      buffer: Buffer.from("b"),
    });
    expect(path.basename(a.abs_path)).not.toBe(path.basename(b.abs_path));
  });

  it("is idempotent on (bridge_id, message_id, filename) — re-save overwrites", async () => {
    const first = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "doc.pdf",
      media_type: "application/pdf",
      message_id: "M1",
      buffer: Buffer.from("first"),
    });
    const second = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "doc.pdf",
      media_type: "application/pdf",
      message_id: "M1",
      buffer: Buffer.from("second-longer"),
    });
    expect(first.abs_path).toBe(second.abs_path);
    const onDisk = await readFile(first.abs_path);
    expect(onDisk.toString("utf8")).toBe("second-longer");
    expect(second.size).toBe(Buffer.byteLength("second-longer"));
  });

  it("isolates bridges from each other in separate subtrees", async () => {
    const a = await saveBridgeAttachment({
      bridge_id: "bridge-a",
      filename: "x.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.from("a"),
    });
    const b = await saveBridgeAttachment({
      bridge_id: "bridge-b",
      filename: "x.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.from("b"),
    });
    expect(path.dirname(path.dirname(a.abs_path))).not.toBe(path.dirname(path.dirname(b.abs_path)));
    expect(a.abs_path).not.toBe(b.abs_path);
  });

  it("handles a zero-byte buffer", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "empty.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.alloc(0),
    });
    expect(saved.size).toBe(0);
    expect(existsSync(saved.abs_path)).toBe(true);
    const stat = statSync(saved.abs_path);
    expect(stat.size).toBe(0);
  });

  it("handles a binary buffer with non-utf8 bytes losslessly", async () => {
    const buf = Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0x80, 0x81]);
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "bin.dat",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: buf,
    });
    const onDisk = await readFile(saved.abs_path);
    expect(onDisk.equals(buf)).toBe(true);
  });

  it("survives concurrent saves to the same bridge", async () => {
    const saves = Array.from({ length: 20 }, (_, i) =>
      saveBridgeAttachment({
        bridge_id: "b1",
        filename: `f-${i}.bin`,
        media_type: "application/octet-stream",
        message_id: `m-${i}`,
        buffer: Buffer.from(`payload-${i}`),
      }),
    );
    const results = await Promise.all(saves);
    const paths = new Set(results.map((r) => r.abs_path));
    expect(paths.size).toBe(20);
    for (const r of results) {
      expect(existsSync(r.abs_path)).toBe(true);
    }
  });

  it("exposes a constants surface used by callers", () => {
    expect(BRIDGE_ATTACHMENTS_DIRNAME).toBe("bridge-attachments");
    expect(DEFAULT_INLINE_LIMIT_BYTES).toBe(1 * 1024 * 1024);
    expect(bridgeAttachmentsRoot().endsWith(BRIDGE_ATTACHMENTS_DIRNAME)).toBe(true);
  });
});

describe("pruneBridgeAttachments", () => {
  it("removes files older than maxAgeMs and keeps fresh ones", async () => {
    const old = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "old.bin",
      media_type: "application/octet-stream",
      message_id: "old",
      buffer: Buffer.from("aaa"),
    });
    const fresh = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "fresh.bin",
      media_type: "application/octet-stream",
      message_id: "fresh",
      buffer: Buffer.from("bbb"),
    });
    // Backdate the old file by 2 hours.
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(old.abs_path, past, past);

    const res = await pruneBridgeAttachments({ maxAgeMs: 60 * 60 * 1000 });
    expect(res.removed_files).toBe(1);
    expect(res.freed_bytes).toBe(3); // "aaa".length
    expect(existsSync(old.abs_path)).toBe(false);
    expect(existsSync(fresh.abs_path)).toBe(true);
  });

  it("removes empty day and bridge directories after purging files", async () => {
    const saved = await saveBridgeAttachment({
      bridge_id: "ghost-bridge",
      filename: "only.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.from("x"),
    });
    const past = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    utimesSync(saved.abs_path, past, past);

    const res = await pruneBridgeAttachments({ maxAgeMs: 60 * 60 * 1000 });
    expect(res.removed_files).toBe(1);
    expect(res.removed_dirs).toBeGreaterThanOrEqual(2); // day dir + bridge dir
    expect(existsSync(path.dirname(saved.abs_path))).toBe(false);
    expect(existsSync(path.dirname(path.dirname(saved.abs_path)))).toBe(false);
  });

  it("keeps the bridge directory if any fresh files remain in any day folder", async () => {
    const stale = await saveBridgeAttachment({
      bridge_id: "mixed",
      filename: "stale.bin",
      media_type: "application/octet-stream",
      message_id: "stale",
      buffer: Buffer.from("x"),
    });
    const fresh = await saveBridgeAttachment({
      bridge_id: "mixed",
      filename: "fresh.bin",
      media_type: "application/octet-stream",
      message_id: "fresh",
      buffer: Buffer.from("y"),
    });
    const past = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale.abs_path, past, past);

    await pruneBridgeAttachments({ maxAgeMs: 60 * 60 * 1000 });
    expect(existsSync(fresh.abs_path)).toBe(true);
    expect(existsSync(path.dirname(fresh.abs_path))).toBe(true);
  });

  it("is a no-op when the attachments dir does not exist", async () => {
    const res = await pruneBridgeAttachments({ maxAgeMs: 1 });
    expect(res).toEqual({ removed_files: 0, removed_dirs: 0, freed_bytes: 0 });
  });

  it("treats maxAgeMs=0 as 'expire everything finished'", async () => {
    await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "a.bin",
      media_type: "application/octet-stream",
      message_id: "a",
      buffer: Buffer.from("a"),
    });
    // Backdate by 1ms so even maxAgeMs=0 expires it.
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "b.bin",
      media_type: "application/octet-stream",
      message_id: "b",
      buffer: Buffer.from("b"),
    });
    const past = (Date.now() - 1000) / 1000;
    utimesSync(saved.abs_path, past, past);
    const res = await pruneBridgeAttachments({ maxAgeMs: 0 });
    expect(res.removed_files).toBeGreaterThanOrEqual(1);
  });

  it("ignores non-file entries inside day folders", async () => {
    // Manually create a stray subdirectory under a day folder — prune
    // must not crash and must not delete it.
    const saved = await saveBridgeAttachment({
      bridge_id: "b1",
      filename: "f.bin",
      media_type: "application/octet-stream",
      message_id: "m",
      buffer: Buffer.from("x"),
    });
    const dayDir = path.dirname(saved.abs_path);
    const strayDir = path.join(dayDir, "stray-subdir");
    mkdirSync(strayDir);
    writeFileSync(path.join(strayDir, "child.txt"), "x");
    const past = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    utimesSync(saved.abs_path, past, past);

    const res = await pruneBridgeAttachments({ maxAgeMs: 60 * 60 * 1000 });
    expect(res.removed_files).toBe(1);
    expect(existsSync(strayDir)).toBe(true);
  });
});

