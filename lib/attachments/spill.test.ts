import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "jarela-spill-"));
process.env.JARELA_DB_DIR = TMP_ROOT;

const { spillFileBuffer, spillImageAttachments, spillImagePart, readImageRef } = await import("./spill");
const { FILES_DIR } = await import("@/lib/files");

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const PNG_B64 = PNG_BYTES.toString("base64");
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");

// Single top-level cleanup so the tmp dir survives across every describe.
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("spillImagePart", () => {
  it("writes the buffer under files/<sha256>.<ext> and returns a ref", async () => {
    const ref = await spillImagePart({ type: "image", media_type: "image/png", data: PNG_B64 });
    expect(ref).toEqual({
      type: "image_ref",
      media_type: "image/png",
      name: `${PNG_SHA}.png`,
      sha256: PNG_SHA,
      size: PNG_BYTES.length,
    });
    expect(existsSync(join(FILES_DIR, ref.name))).toBe(true);
    expect(readFileSync(join(FILES_DIR, ref.name))).toEqual(PNG_BYTES);
  });

  it("is idempotent when the same bytes are spilled twice", async () => {
    const a = await spillImagePart({ type: "image", media_type: "image/png", data: PNG_B64 });
    const b = await spillImagePart({ type: "image", media_type: "image/png", data: PNG_B64 });
    expect(a).toEqual(b);
  });

  it("maps unknown mime types to .bin", async () => {
    const ref = await spillImagePart({ type: "image", media_type: "image/x-weird", data: PNG_B64 });
    expect(ref.name.endsWith(".bin")).toBe(true);
  });
});

describe("spillImageAttachments", () => {
  it("replaces image parts and leaves text/file/image_ref untouched", async () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "image", media_type: "image/png", data: PNG_B64 },
      { type: "file", name: "notes.txt", media_type: "text/plain", data: "abc" },
      { type: "image_ref", media_type: "image/png", name: `${PNG_SHA}.png`, sha256: PNG_SHA },
    ] as const;
    const out = await spillImageAttachments([...parts]);
    expect(out[0]).toEqual(parts[0]);
    expect(out[1]).toMatchObject({ type: "image_ref", media_type: "image/png", name: `${PNG_SHA}.png` });
    expect(out[2]).toEqual(parts[2]);
    expect(out[3]).toEqual(parts[3]);
  });
});

describe("spillFileBuffer", () => {
  it("writes a binary file and returns a lightweight ref", async () => {
    const buf = Buffer.from("%PDF-fake");
    const sha = createHash("sha256").update(buf).digest("hex");
    const ref = await spillFileBuffer(buf, "application/pdf", "report.pdf");

    expect(ref).toEqual({
      type: "file_ref",
      media_type: "application/pdf",
      name: `${sha}.pdf`,
      filename: "report.pdf",
      sha256: sha,
      size: buf.length,
    });
    expect(readFileSync(join(FILES_DIR, ref.name))).toEqual(buf);
  });
});

describe("readImageRef", () => {
  it("reads the persisted bytes back for a valid ref", async () => {
    const ref = await spillImagePart({ type: "image", media_type: "image/png", data: PNG_B64 });
    const buf = await readImageRef({ media_type: ref.media_type, name: ref.name });
    expect(buf).toEqual(PNG_BYTES);
  });

  it("refuses unsafe file names", async () => {
    await expect(readImageRef({ media_type: "image/png", name: "../etc/passwd" })).rejects.toThrow(/unsafe/);
  });
});
