import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE_PX,
  IMAGE_PASSTHROUGH_BYTES,
  downscaleImageFile,
  fitWithin,
  type DecodeImage,
} from "./downscale-image";

function photo(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1 });
}

function fakeDecoder(width: number, height: number, encodedBytes: number | null) {
  const close = vi.fn();
  const encodeJpeg = vi.fn(async () => (encodedBytes === null ? null : new Blob([new Uint8Array(encodedBytes)], { type: "image/jpeg" })));
  const decode: DecodeImage = vi.fn(async () => ({ width, height, encodeJpeg, close }));
  return { decode, encodeJpeg, close };
}

describe("downscaleImageFile", () => {
  it("shrinks a large phone photo to a 1568px JPEG and keeps the base name", async () => {
    const { decode, encodeJpeg, close } = fakeDecoder(4032, 3024, 210_000);
    const out = await downscaleImageFile(photo("IMG_0001.jpeg", "image/jpeg", 4_000_000), decode);

    expect(encodeJpeg).toHaveBeenCalledWith(IMAGE_MAX_EDGE_PX, 1176, IMAGE_JPEG_QUALITY);
    expect(out).toMatchObject({ name: "IMG_0001.jpg", type: "image/jpeg", size: 210_000 });
    expect(close).toHaveBeenCalled();
  });

  it("passes small screenshots through byte-identical without decoding", async () => {
    const { decode } = fakeDecoder(800, 600, 1);
    const small = photo("shot.png", "image/png", IMAGE_PASSTHROUGH_BYTES);
    expect(await downscaleImageFile(small, decode)).toBe(small);
    expect(decode).not.toHaveBeenCalled();
  });

  it("converts small HEIC photos because most providers cannot read them", async () => {
    const { decode } = fakeDecoder(1000, 750, 90_000);
    const out = await downscaleImageFile(photo("IMG_0002.HEIC", "", 60_000), decode);
    expect(out).toMatchObject({ name: "IMG_0002.jpg", type: "image/jpeg" });
  });

  it("keeps animated GIFs and SVGs untouched", async () => {
    const { decode } = fakeDecoder(2000, 2000, 1);
    const gif = photo("party.gif", "image/gif", 3_000_000);
    const svg = photo("logo.svg", "image/svg+xml", 900_000);
    expect(await downscaleImageFile(gif, decode)).toBe(gif);
    expect(await downscaleImageFile(svg, decode)).toBe(svg);
    expect(decode).not.toHaveBeenCalled();
  });

  it("keeps GIFs, SVGs and icons untouched when the browser reports no MIME type", async () => {
    const { decode } = fakeDecoder(2000, 2000, 1);
    for (const name of ["party.GIF", "logo.svg", "favicon.ico"]) {
      const file = photo(name, "", 3_000_000);
      expect(await downscaleImageFile(file, decode)).toBe(file);
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it("keeps the original when re-encoding would not make it smaller", async () => {
    const { decode } = fakeDecoder(1200, 900, 700_000);
    const original = photo("scan.jpg", "image/jpeg", 600_000);
    expect(await downscaleImageFile(original, decode)).toBe(original);
  });

  it("falls back to the original file when decoding or encoding fails", async () => {
    const original = photo("broken.jpg", "image/jpeg", 2_000_000);
    const failing: DecodeImage = async () => { throw new Error("unsupported"); };
    expect(await downscaleImageFile(original, failing)).toBe(original);

    const { decode, close } = fakeDecoder(4000, 3000, null);
    expect(await downscaleImageFile(original, decode)).toBe(original);
    expect(close).toHaveBeenCalled();
  });
});

describe("fitWithin", () => {
  it("caps the longest edge for portrait and landscape and never upscales", () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1176, height: IMAGE_MAX_EDGE_PX });
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(10_000, 1)).toEqual({ width: IMAGE_MAX_EDGE_PX, height: 1 });
  });
});
