// Image shrink helper for the attachment spill pipeline.
//
// The vision APIs of every provider we speak to today accept an image
// as a base64 blob in the request body, but they don't need a 4032×3024
// iPhone photo to answer "who's in this picture?" — the model's vision
// encoder downsamples to a fixed grid anyway (Anthropic ~1568px, OpenAI
// ~2048px, Gemini ~3072px). Shipping the original is pure waste: it
// costs upload latency, tokens (image tokens scale with pixels on some
// providers), and disk space post-spill.
//
// Runs at ingest inside `spillImagePart` so every ref on disk starts
// already resized. See ADR-0065 (spill) and ADR-0066 (this).

import type { ContentPart } from "@/lib/tools/types";

export interface ShrinkResult {
  buf: Buffer;
  media_type: string;
  width: number;
  height: number;
  /** True if the original buffer was returned unchanged. */
  passthrough: boolean;
}

export interface ShrinkOpts {
  /** Longest side after resize (px). Default 1600. */
  maxEdge?: number;
  /** JPEG re-encode quality (1..100). Default 85. */
  jpegQuality?: number;
  /**
   * Skip the resize when the input is already small enough that the
   * saving isn't worth an encoder round trip. Default 64 KB.
   */
  minBytesToTouch?: number;
}

// Providers reject or misrender these — always transcode to JPEG.
const FORCE_TO_JPEG = new Set([
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
]);

// Formats where we always keep the source bytes as-is: vector or animated.
const ALWAYS_PASSTHROUGH = new Set([
  "image/svg+xml",
  "image/gif", // frames would be lost on a still re-encode
]);

/**
 * Resize and re-encode an image if doing so shrinks the payload without
 * losing meaningful information. Preserves alpha (stays PNG), converts
 * HEIC/BMP/TIFF to JPEG, leaves SVG/GIF untouched.
 *
 * Never throws — a decode failure returns the input unchanged so the
 * caller can still spill something rather than lose the attachment.
 */
export async function shrinkImage(
  input: Buffer,
  mediaType: string,
  opts: ShrinkOpts = {},
): Promise<ShrinkResult> {
  const maxEdge = opts.maxEdge ?? 1600;
  const jpegQuality = opts.jpegQuality ?? 85;
  const minBytesToTouch = opts.minBytesToTouch ?? 64 * 1024;
  const mt = mediaType.toLowerCase();

  if (ALWAYS_PASSTHROUGH.has(mt)) {
    return { buf: input, media_type: mediaType, width: 0, height: 0, passthrough: true };
  }

  // Dynamic import: sharp loads a native binary, don't pay that cost on
  // installs that never see an image ingest. Not in tsconfig paths so
  // it resolves relative to node_modules at runtime.
  let sharpFn: typeof import("sharp").default;
  try {
    const mod = await import("sharp");
    sharpFn = mod.default;
  } catch (err) {
    console.warn("[shrink] sharp unavailable, passing image through:", (err as Error).message);
    return { buf: input, media_type: mediaType, width: 0, height: 0, passthrough: true };
  }

  let meta: import("sharp").Metadata;
  try {
    meta = await sharpFn(input, { failOn: "none" }).metadata();
  } catch (err) {
    console.warn("[shrink] decode failed, passing through:", (err as Error).message);
    return { buf: input, media_type: mediaType, width: 0, height: 0, passthrough: true };
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const longestEdge = Math.max(width, height);
  const forceJpeg = FORCE_TO_JPEG.has(mt);
  const wantResize = longestEdge > maxEdge;

  // Early bail-out: tiny file, in-bounds, and no forced transcode.
  if (!forceJpeg && !wantResize && input.length <= minBytesToTouch) {
    return { buf: input, media_type: mediaType, width, height, passthrough: true };
  }

  // Preserve alpha by keeping PNG when the source has it — dropping to
  // JPEG would flatten transparent regions to black.
  const keepPng = !forceJpeg && (meta.hasAlpha ?? false) && mt === "image/png";
  const outMediaType = keepPng ? "image/png" : "image/jpeg";

  try {
    let pipeline = sharpFn(input, { failOn: "none" });
    if (wantResize) {
      pipeline = pipeline.resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    // Strip EXIF (may contain location) and re-encode.
    pipeline = pipeline.rotate(); // apply EXIF orientation before stripping metadata
    const outBuf = keepPng
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : await pipeline.jpeg({ quality: jpegQuality, mozjpeg: true }).toBuffer();

    // If the "shrink" made the file BIGGER (already-optimised small JPEG
    // running through mozjpeg can occasionally grow) and no format change
    // was forced, fall back to the original.
    if (!forceJpeg && !wantResize && outBuf.length >= input.length) {
      return { buf: input, media_type: mediaType, width, height, passthrough: true };
    }

    // Re-read metadata for the exact output dimensions.
    const outMeta = await sharpFn(outBuf, { failOn: "none" }).metadata().catch(() => meta);
    return {
      buf: outBuf,
      media_type: outMediaType,
      width: outMeta.width ?? width,
      height: outMeta.height ?? height,
      passthrough: false,
    };
  } catch (err) {
    console.warn("[shrink] encode failed, passing through:", (err as Error).message);
    return { buf: input, media_type: mediaType, width, height, passthrough: true };
  }
}

/** Convenience for callers holding a full ContentPart. */
export async function shrinkImagePart(
  part: { type: "image"; media_type: string; data: string },
  opts?: ShrinkOpts,
): Promise<{ buf: Buffer; media_type: string; width: number; height: number; passthrough: boolean }>
{
  return shrinkImage(Buffer.from(part.data, "base64"), part.media_type, opts);
}

// Re-export type so callers don't need two imports.
export type { ContentPart };
