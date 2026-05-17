// Generates Jarela logo asset variants from public/logo-source.png.
//
// Output (all PNG unless noted):
//   public/logo-mark.png             320 wide, white bg          (README hero)
//   public/logo-mark-transparent.png 512 wide, transparent bg    (dark mode / overlays)
//   public/icon-192.png              192x192, transparent bg     (PWA)
//   public/icon-512.png              512x512, transparent bg     (PWA)
//   public/icon-192-maskable.png     192x192, brand-blue bg      (PWA maskable)
//   public/icon-512-maskable.png     512x512, brand-blue bg      (PWA maskable)
//   public/apple-touch-icon.png      180x180, brand-blue bg      (iOS home screen)
//   public/favicon-32.png             32x32,  transparent bg     (site icon, modern)
//   public/favicon-16.png             16x16,  transparent bg     (site icon, legacy)
//   public/favicon.ico                multi-res ICO (32 + 16)    (browsers)
//
// Run: node scripts/gen-logo.mjs

import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = new URL("../public/", import.meta.url);
const SRC = new URL("logo-source.png", PUBLIC).pathname.replace(/^\//, "");
const out = (name) => new URL(name, PUBLIC).pathname.replace(/^\//, "");

// Brand-blue background used for maskable + apple-touch icons. Matches the
// blue gradient stop in the logo.
const BG = { r: 30, g: 64, b: 175, alpha: 1 }; // #1e40af

// ---- helper: trim the source and key out the near-white background ---------
//
// Approach: extract the grayscale of the trimmed image, invert it → that
// becomes the alpha channel (white = 0, dark blue = ~255). Merge it back into
// the RGB image as the alpha channel and return a self-contained PNG buffer.
let _markCache = null;
async function transparentMarkPng() {
  if (_markCache) return _markCache;
  const trimmed = sharp(SRC).trim({ threshold: 10 });
  const { data: rgbData, info } = await trimmed
    .clone()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaRaw = await trimmed
    .clone()
    .grayscale()
    .negate()
    .raw()
    .toBuffer();

  // Boost alpha slightly so anti-aliased edges stay visible.
  const alpha = Buffer.alloc(alphaRaw.length);
  for (let i = 0; i < alphaRaw.length; i++) {
    const v = alphaRaw[i];
    alpha[i] = v < 12 ? 0 : Math.min(255, Math.round(v * 1.15));
  }

  _markCache = await sharp(rgbData, {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .joinChannel(alpha, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return _markCache;
}

// ---- helper: fit the transparent mark into a square canvas -----------------
async function squareIcon({ size, bg, padding = 0.12 }) {
  const inner = Math.round(size * (1 - padding * 2));
  const markPng = await transparentMarkPng();
  const resized = await sharp(markPng)
    .resize({ width: inner, height: inner, fit: "inside" })
    .png()
    .toBuffer();

  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: bg ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  return canvas
    .composite([{ input: resized, gravity: "center" }])
    .png({ compressionLevel: 9 });
}

// ---- main ------------------------------------------------------------------
async function main() {
  // 1. README hero (white bg) — keep existing behavior
  await sharp(SRC)
    .trim({ threshold: 10 })
    .resize({ width: 320 })
    .png({ compressionLevel: 9 })
    .toFile(out("logo-mark.png"));

  // 2. Transparent-bg mark for dark backgrounds / overlays
  const markPng = await transparentMarkPng();
  await sharp(markPng)
    .resize({ width: 512 })
    .png({ compressionLevel: 9 })
    .toFile(out("logo-mark-transparent.png"));

  // 3. PWA app icons (transparent)
  for (const size of [192, 512]) {
    await (await squareIcon({ size })).toFile(out(`icon-${size}.png`));
  }

  // 4. Maskable variants (solid brand bg, smaller safe area for icon mask)
  for (const size of [192, 512]) {
    await (
      await squareIcon({ size, bg: BG, padding: 0.18 })
    ).toFile(out(`icon-${size}-maskable.png`));
  }

  // 5. Apple touch icon
  await (
    await squareIcon({ size: 180, bg: BG, padding: 0.12 })
  ).toFile(out("apple-touch-icon.png"));

  // 6. Favicons
  await (await squareIcon({ size: 32 })).toFile(out("favicon-32.png"));
  await (await squareIcon({ size: 16 })).toFile(out("favicon-16.png"));

  // 7. Multi-res ICO. Sharp can't write ICO directly, but we can encode two
  // PNGs into a minimal ICO container.
  const png32 = await (await squareIcon({ size: 32 })).toBuffer();
  const png16 = await (await squareIcon({ size: 16 })).toBuffer();
  writeFileSync(out("favicon.ico"), buildIco([png16, png32]));

  // 8. Vector wrapper SVG embedding a 256-wide transparent PNG. Not a true
  // vector but stays crisp at typical UI sizes (≤96px) and avoids hand-drawn
  // approximations. Keep the embedded raster small so the SVG stays under a
  // few KB.
  const svgPng = await sharp(markPng).resize({ width: 256 }).png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(svgPng).metadata();
  const embed = svgPng.toString("base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${meta.width} ${meta.height}" width="${meta.width}" height="${meta.height}"><image href="data:image/png;base64,${embed}" width="${meta.width}" height="${meta.height}"/></svg>\n`;
  writeFileSync(out("logo.svg"), svg);

  console.log("ok");
}

// Minimal ICO encoder embedding PNG payloads (supported by all modern browsers).
// Layout: ICONDIR (6) + ICONDIRENTRY * n (16 each) + payloads.
function buildIco(pngs) {
  const sizes = pngs.map((p) => {
    // Read width/height from the PNG IHDR chunk (bytes 16..23, big-endian).
    return { w: p.readUInt32BE(16), h: p.readUInt32BE(20), buf: p };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(sizes.length, 4);

  const entries = Buffer.alloc(16 * sizes.length);
  const payloads = [];
  let offset = 6 + 16 * sizes.length;
  sizes.forEach(({ w, h, buf }, i) => {
    const off = i * 16;
    entries.writeUInt8(w >= 256 ? 0 : w, off + 0);
    entries.writeUInt8(h >= 256 ? 0 : h, off + 1);
    entries.writeUInt8(0, off + 2); // color palette
    entries.writeUInt8(0, off + 3); // reserved
    entries.writeUInt16LE(1, off + 4); // color planes
    entries.writeUInt16LE(32, off + 6); // bpp
    entries.writeUInt32LE(buf.length, off + 8);
    entries.writeUInt32LE(offset, off + 12);
    offset += buf.length;
    payloads.push(buf);
  });

  return Buffer.concat([header, entries, ...payloads]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
