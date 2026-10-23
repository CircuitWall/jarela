// Client-side photo downscaling before upload. Raw phone photos (3–12 MB)
// exceed Anthropic's 5 MB per-image cap and inflate prompt size; a 1568 px
// longest edge is the high-detail sweet spot for Anthropic and OpenAI.

export const IMAGE_MAX_EDGE_PX = 1568;
export const IMAGE_PASSTHROUGH_BYTES = 512 * 1024;
export const IMAGE_JPEG_QUALITY = 0.85;

export interface DecodedImage {
  width: number;
  height: number;
  /** Render at the given size and encode as JPEG; null when encoding fails. */
  encodeJpeg(width: number, height: number, quality: number): Promise<Blob | null>;
  close(): void;
}

export type DecodeImage = (file: Blob) => Promise<DecodedImage>;

const HEIF_RE = /\.(heic|heif)$/i;
// Animation (GIF), vector (SVG) and icons lose meaning when flattened to JPEG.
const KEEP_AS_IS_RE = /^image\/(gif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;
const KEEP_AS_IS_EXT_RE = /\.(gif|svg|ico)$/i;

function isHeif(file: File): boolean {
  return /heic|heif/i.test(file.type) || HEIF_RE.test(file.name);
}

export function shouldDownscale(file: File): boolean {
  if (KEEP_AS_IS_RE.test(file.type) || KEEP_AS_IS_EXT_RE.test(file.name)) return false;
  return isHeif(file) || file.size > IMAGE_PASSTHROUGH_BYTES;
}

export function fitWithin(width: number, height: number, maxEdge = IMAGE_MAX_EDGE_PX): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}.jpg`;
}

/**
 * Returns a JPEG no larger than IMAGE_MAX_EDGE_PX on its longest edge, or the
 * original file when it is already small, should not be flattened, cannot be
 * decoded/encoded, or would not get smaller. Never throws.
 */
export async function downscaleImageFile(file: File, decode: DecodeImage = decodeWithBrowser): Promise<File> {
  if (!shouldDownscale(file)) return file;
  let image: DecodedImage | null = null;
  try {
    image = await decode(file);
    const size = fitWithin(image.width, image.height);
    const blob = await image.encodeJpeg(size.width, size.height, IMAGE_JPEG_QUALITY);
    if (!blob || blob.size === 0) return file;
    // HEIC is unreadable by most providers, so converting it wins even if larger.
    if (blob.size >= file.size && !isHeif(file)) return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    image?.close();
  }
}

async function decodeWithBrowser(file: Blob): Promise<DecodedImage> {
  // createImageBitmap applies EXIF orientation, so rotated phone photos stay upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  return {
    width: bitmap.width,
    height: bitmap.height,
    async encodeJpeg(width, height, quality) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // JPEG has no alpha; paint white so transparent PNG regions don't turn black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    },
    close: () => bitmap.close(),
  };
}
