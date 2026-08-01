import { describe, it, expect } from "vitest";
import { shrinkImage } from "./shrink";

// Sharp is loaded dynamically; if it fails to load these tests will exercise
// the passthrough path — that's a valid outcome and asserted where relevant.

async function makeJpeg(w: number, h: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  }).jpeg({ quality: 95 }).toBuffer();
}

async function makeAlphaPng(w: number, h: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer();
}

describe("shrinkImage", () => {
  it("passes tiny images through untouched", async () => {
    const small = await makeJpeg(64, 64);
    const out = await shrinkImage(small, "image/jpeg");
    expect(out.passthrough).toBe(true);
    expect(out.buf).toBe(small);
    expect(out.media_type).toBe("image/jpeg");
  });

  it("resizes a 4000px image down to 1600px longest edge", async () => {
    const big = await makeJpeg(4000, 3000);
    const out = await shrinkImage(big, "image/jpeg");
    expect(out.passthrough).toBe(false);
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1200);
    // JPEG re-encode of a synthetic solid-colour image should be << original.
    expect(out.buf.length).toBeLessThan(big.length);
    expect(out.media_type).toBe("image/jpeg");
  });

  it("keeps PNG when the source has alpha", async () => {
    const png = await makeAlphaPng(3000, 3000);
    const out = await shrinkImage(png, "image/png");
    expect(out.passthrough).toBe(false);
    expect(out.media_type).toBe("image/png");
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1600);
  });

  it("leaves SVG alone", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='2000' height='2000'></svg>");
    const out = await shrinkImage(svg, "image/svg+xml");
    expect(out.passthrough).toBe(true);
    expect(out.buf).toBe(svg);
    expect(out.media_type).toBe("image/svg+xml");
  });

  it("leaves GIF alone (would lose animation)", async () => {
    // Not a real GIF — the passthrough path exits before sharp is called.
    const gif = Buffer.from("GIF89a-fake");
    const out = await shrinkImage(gif, "image/gif");
    expect(out.passthrough).toBe(true);
  });

  it("passes garbage bytes through without throwing", async () => {
    const junk = Buffer.from("this is not an image");
    const out = await shrinkImage(junk, "image/jpeg");
    expect(out.passthrough).toBe(true);
    expect(out.buf).toBe(junk);
  });
});
