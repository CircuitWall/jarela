// Attachment spill store.
//
// Turns inline `image` ContentParts (base64 blob in the message row) into
// `image_ref` parts that point at a file under `<dataDir>/files/`. The
// message row shrinks from ~400 KB per image to ~200 B; the LLM adapter
// reads the file back and re-encodes to base64 only at invocation time,
// so the bytes never enter the checkpoint store or the warm summariser.
//
// Content-addressed: the on-disk file name is `<sha256>.<ext>` so an image
// forwarded / retried / re-ingested twice collapses to one file. This is
// the primitive the previous "delete-checkpoints-per-turn" hack was
// compensating for — see ADR-0065.

import { promises as fsp, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FILES_DIR, isSafeFileName } from "@/lib/files";
import type { ContentPart } from "@/lib/tools/types";

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
};

function extForMime(media_type: string): string {
  return MIME_EXT[media_type.toLowerCase()] ?? "bin";
}

/**
 * Persist one base64-encoded image blob to the files dir, keyed by its
 * content hash. Idempotent: re-writing the same bytes is a no-op.
 * Returns the `image_ref` variant the caller should store instead.
 */
export async function spillImagePart(part: {
  type: "image";
  media_type: string;
  data: string;
}): Promise<Extract<ContentPart, { type: "image_ref" }>> {
  const buf = Buffer.from(part.data, "base64");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const name = `${sha256}.${extForMime(part.media_type)}`;
  if (!isSafeFileName(name)) throw new Error(`spill: unsafe file name ${name}`);
  const abs = join(FILES_DIR, name);

  // Skip the write if the file already exists — content-addressed so
  // identical bytes always land at the same name.
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
  return {
    type: "image_ref",
    media_type: part.media_type,
    name,
    sha256,
    size: buf.length,
  };
}

/**
 * Walk a ContentPart[] and replace every inline `image` part with an
 * `image_ref`. Leaves other part types untouched. Safe to call on
 * already-refactored parts — the `image_ref` variant is passed through.
 * Returns a new array (does not mutate the input).
 */
export async function spillImageAttachments(parts: ContentPart[]): Promise<ContentPart[]> {
  const out: ContentPart[] = [];
  for (const p of parts) {
    if (p.type === "image") out.push(await spillImagePart(p));
    else out.push(p);
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
