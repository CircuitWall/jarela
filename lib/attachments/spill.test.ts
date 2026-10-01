import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "jarela-spill-"));
process.env.JARELA_DB_DIR = TMP_ROOT;

const { spillFileBuffer, spillAttachments, spillImagePart, readImageRef, readFileRef } = await import("./spill");
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

describe("spillAttachments", () => {
  it("replaces image and file parts, leaves text/image_ref/file_ref untouched", async () => {
    const parts = [
      { type: "text", text: "hello" },
      { type: "image", media_type: "image/png", data: PNG_B64 },
      { type: "file", name: "notes.txt", media_type: "text/plain", data: "abc" },
      { type: "image_ref", media_type: "image/png", name: `${PNG_SHA}.png`, sha256: PNG_SHA },
      { type: "file_ref", media_type: "application/pdf", name: "deadbeef.pdf", filename: "r.pdf", sha256: "deadbeef" },
    ] as const;
    const out = await spillAttachments([...parts]);
    expect(out[0]).toEqual(parts[0]);
    expect(out[1]).toMatchObject({ type: "image_ref", media_type: "image/png", name: `${PNG_SHA}.png` });
    expect(out[2]).toMatchObject({ type: "file_ref", media_type: "text/plain", filename: "notes.txt" });
    expect(out[3]).toEqual(parts[3]);
    expect(out[4]).toEqual(parts[4]);
  });

  it("spills a text file part so its content can be read back via readFileRef", async () => {
    const [ref] = await spillAttachments([
      { type: "file", name: "notes.txt", media_type: "text/plain", data: "line one\nline two" },
    ]) as [Extract<import("@/lib/tools/runtime/types").ContentPart, { type: "file_ref" }>];
    const buf = await readFileRef({ name: ref.name });
    expect(buf.toString("utf8")).toBe("line one\nline two");
  });

  it("decodes base64 data for a non-text file part before spilling", async () => {
    const buf = Buffer.from("%PDF-fake-binary");
    const [ref] = await spillAttachments([
      { type: "file", name: "r.pdf", media_type: "application/pdf", data: buf.toString("base64") },
    ]) as [Extract<import("@/lib/tools/runtime/types").ContentPart, { type: "file_ref" }>];
    expect(await readFileRef({ name: ref.name })).toEqual(buf);
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

describe("readFileRef", () => {
  it("reads the persisted bytes back for a valid ref", async () => {
    const buf = Buffer.from("hello file");
    const ref = await spillFileBuffer(buf, "text/plain", "hello.txt");
    expect(await readFileRef({ name: ref.name })).toEqual(buf);
  });

  it("refuses unsafe file names", async () => {
    await expect(readFileRef({ name: "../etc/passwd" })).rejects.toThrow(/unsafe/);
  });
});
