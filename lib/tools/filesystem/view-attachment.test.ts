import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-view-attachment-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { viewAttachmentTool } = await import("./view-attachment");
const { spillImagePart, spillFileBuffer } = await import("@/lib/attachments/spill");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function parse(raw: string): Record<string, unknown> {
  return JSON.parse(raw);
}

describe("viewAttachmentTool", () => {
  it("returns a URL (not pixels) for an image ref, and says so explicitly", async () => {
    const ref = await spillImagePart({ type: "image", media_type: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") });
    const out = parse(await viewAttachmentTool.invoke({ name: ref.name, media_type: "image/png" }));
    expect(out).toMatchObject({ ok: true, kind: "image", url: `/api/v1/files/${ref.name}` });
    expect(String(out.note)).toMatch(/do not regain visual access/i);
  });

  it("returns the real text content for a text file_ref", async () => {
    const ref = await spillFileBuffer(Buffer.from("the actual contents"), "text/plain", "notes.txt");
    const out = parse(await viewAttachmentTool.invoke({ name: ref.name, media_type: "text/plain" }));
    expect(out).toMatchObject({ ok: true, kind: "file", content: "the actual contents", truncated: false });
  });

  it("returns a URL instead of content for a binary file_ref", async () => {
    const ref = await spillFileBuffer(Buffer.from("%PDF-fake"), "application/pdf", "report.pdf");
    const out = parse(await viewAttachmentTool.invoke({ name: ref.name, media_type: "application/pdf" }));
    expect(out).toMatchObject({ ok: true, kind: "file", url: `/api/v1/files/${ref.name}` });
    expect(out.content).toBeUndefined();
  });

  it("refuses an unsafe name instead of touching the filesystem", async () => {
    const out = parse(await viewAttachmentTool.invoke({ name: "../../etc/passwd", media_type: "text/plain" }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/unsafe/i);
  });

  it("reports an error for a ref that no longer exists on disk", async () => {
    const out = parse(await viewAttachmentTool.invoke({
      name: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.txt",
      media_type: "text/plain",
    }));
    expect(out.ok).toBe(false);
  });
});
