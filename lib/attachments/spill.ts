// Attachment spill store.
//
// Turns inline `image`/`file` ContentParts (base64 or text blob in the
// message row) into `image_ref`/`file_ref` parts that point at a file under
// `<dataDir>/files/`. The message row shrinks from ~400 KB per image to
// ~200 B; `toBaseMessages` in lib/agents/llm.ts reads the file back only
// when it needs to (see ADR-0090), so the bytes never enter the checkpoint
// store or the warm summariser.
//
// Content-addressed: the on-disk file name is `<sha256>.<ext>` so an image
// forwarded / retried / re-ingested twice collapses to one file. This is
// the primitive the previous "delete-checkpoints-per-turn" hack was
// compensating for — see ADR-0065.

import { promises as fsp, statSync } from "node:fs";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { FILES_DIR, isSafeFileName } from "@/lib/files";
import { shrinkImage, type ShrinkOpts } from "@/lib/attachments/shrink";
import type { ContentPart } from "@/lib/tools/runtime/types";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "application/pdf": "pdf",
  "application/json": "json",
  "text/plain": "txt",
};

function extForMime(media_type: string): string {
  return MIME_EXT[media_type.toLowerCase()] ?? "bin";
}

function isTextMediaType(media_type: string): boolean {
  return media_type.startsWith("text/") || media_type === "application/json";
}

function safeDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.replace(/[\r\n\t]/g, " ").slice(0, 240) : "attachment";
}

function extForFile(media_type: string, filename?: string): string {
  const fromMime = extForMime(media_type);
  if (fromMime !== "bin") return fromMime;
  const ext = filename ? extname(filename).slice(1).toLowerCase() : "";
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : "bin";
}

async function writeContentAddressedFile(buf: Buffer, ext: string): Promise<{ name: string; sha256: string }> {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const name = `${sha256}.${ext}`;
  if (!isSafeFileName(name)) throw new Error(`spill: unsafe file name ${name}`);
  const abs = join(FILES_DIR, name);

  let exists = false;
  try {
    const s = statSync(abs);
    exists = s.isFile() && s.size === buf.length;
  } catch {
    exists = false;
  }
  if (!exists) {
    await fsp.writeFile(abs, buf);
  }
  return { name, sha256 };
}

/**
 * Persist one base64-encoded image blob to the files dir, keyed by its
 * content hash. Idempotent: re-writing the same bytes is a no-op.
 * Returns the `image_ref` variant the caller should store instead.
 *
 * The blob is run through `shrinkImage` first (ADR-0066) so what lands
 * on disk is already resized to a vision-friendly 1600px max-edge and
 * transcoded off HEIC/BMP/TIFF. Pass `shrink: { maxEdge: 0 }`-style
 * opts through if you need to override defaults.
 */
export async function spillImageBuffer(
  raw: Buffer,
  media_type: string,
  opts?: { shrink?: ShrinkOpts; filename?: string },
): Promise<Extract<ContentPart, { type: "image_ref" }>> {
  const shrunk = await shrinkImage(raw, media_type, opts?.shrink);
  const buf = shrunk.buf;
  const storedMediaType = shrunk.media_type;
  const { name, sha256 } = await writeContentAddressedFile(buf, extForMime(storedMediaType));
  const ref: Extract<ContentPart, { type: "image_ref" }> = {
    type: "image_ref",
    media_type: storedMediaType,
    name,
    sha256,
    size: buf.length,
  };
  if (opts?.filename) ref.filename = safeDisplayName(opts.filename);
  if (shrunk.width) ref.width = shrunk.width;
  if (shrunk.height) ref.height = shrunk.height;
  return ref;
}

export async function spillImagePart(
  part: { type: "image"; media_type: string; data: string },
  opts?: { shrink?: ShrinkOpts; filename?: string },
): Promise<Extract<ContentPart, { type: "image_ref" }>> {
  return spillImageBuffer(Buffer.from(part.data, "base64"), part.media_type, opts);
}

export async function spillFileBuffer(
  raw: Buffer,
  media_type: string,
  filename: string,
): Promise<Extract<ContentPart, { type: "file_ref" }>> {
  const { name, sha256 } = await writeContentAddressedFile(raw, extForFile(media_type, filename));
  return {
    type: "file_ref",
    media_type,
    name,
    filename: safeDisplayName(filename),
    sha256,
    size: raw.length,
  };
}

/**
 * Walk a ContentPart[] and replace every inline `image`/`file` part with an
 * `image_ref`/`file_ref`. Leaves other part types untouched. Safe to call on
 * already-refactored parts — the ref variants are passed through.
 * Returns a new array (does not mutate the input).
 *
 * `file.data` is plain UTF-8 text for text/json attachments (the InputBar
 * client reads text/code files with `readAsText`, never base64) and base64
 * otherwise, mirroring the decode convention already used to render `file`
 * parts in lib/agents/llm.ts and the provider adapters.
 */
export async function spillAttachments(
  parts: ContentPart[],
  opts?: { shrink?: ShrinkOpts },
): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const p of parts) {
    if (p.type === "image") out.push(await spillImagePart(p, opts));
    else if (p.type === "file") {
      const buf = isTextMediaType(p.media_type) ? Buffer.from(p.data, "utf8") : Buffer.from(p.data, "base64");
      out.push(await spillFileBuffer(buf, p.media_type, p.name));
    } else out.push(p);
  }
  return out;
}

/**
 * Read an `image_ref` back off disk as raw bytes. Used at LLM invocation
 * time (see `toBaseMessages` in `lib/agents/llm.ts`) — the base64
 * re-encoding lives on the provider block only, never in state.
 * Throws when the file is missing so the caller can surface a clear error
 * to the user instead of the provider returning a puzzling 400.
 */
export async function readImageRef(ref: {
  media_type: string;
  name: string;
}): Promise<Buffer> {
  if (!isSafeFileName(ref.name)) {
    throw new Error(`readImageRef: unsafe file name ${ref.name}`);
  }
  const abs = join(FILES_DIR, ref.name);
  return fsp.readFile(abs);
}

/**
 * Read a `file_ref` back off disk as raw bytes. Same shape as
 * `readImageRef` — used both for the newest turn's full readout and for
 * the `view_attachment` tool's on-demand re-read (ADR-0090).
 */
export async function readFileRef(ref: { name: string }): Promise<Buffer> {
  if (!isSafeFileName(ref.name)) {
    throw new Error(`readFileRef: unsafe file name ${ref.name}`);
  }
  const abs = join(FILES_DIR, ref.name);
  return fsp.readFile(abs);
}
