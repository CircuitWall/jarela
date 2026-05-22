// Generate placeholder PNG icons for the extension. Replace with real art
// before publishing — these exist solely so chrome.action has something to
// render and so the manifest doesn't 404.
//
// Glyph: two corner brackets forming a "viewfinder" — the universal
// picker / select-an-element affordance. Transparent everywhere else so
// the icon reads on both light and dark browser toolbars rather than
// fighting the toolbar with a solid background fill.
//
// Run: node browser-extension/scripts/generate-icons.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "..", "icons");
mkdirSync(iconsDir, { recursive: true });

// Foreground colors. Slate-800 on light toolbars + a 1px slate-50 inner
// halo so the bracket stays visible on dark toolbars too. Disabled state
// drops to slate-400 with no halo (naturally communicates "off").
const ENABLED_FG = { r: 30, g: 41, b: 59 };     // slate-800
const ENABLED_HALO = { r: 248, g: 250, b: 252 }; // slate-50
const DISABLED_FG = { r: 148, g: 163, b: 184 }; // slate-400

function crc32() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
}
const crc = crc32();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const crcVal = crc(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, drawPixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // Each row: filter byte (0 = none) + RGBA pixels.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size); // zero-initialised → fully transparent
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const px = drawPixel(x, y);
      if (!px) continue; // leave transparent
      const off = y * stride + 1 + x * 4;
      raw[off + 0] = px.r;
      raw[off + 1] = px.g;
      raw[off + 2] = px.b;
      raw[off + 3] = px.a ?? 255;
    }
  }
  const idat = deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Picker viewfinder: top-left + bottom-right corner brackets with a
// transparent middle. Bracket arm length = ~40% of the icon, thickness
// scales with size so it looks the same density at every scale.
function brackets(size, fg, halo) {
  const thickness = Math.max(1, Math.round(size / 12));
  const armLen = Math.round(size * 0.4);
  const inset = Math.max(1, Math.round(size / 12));
  const haloT = halo ? Math.max(1, Math.round(size / 16)) : 0;

  // Inclusive-bounds rectangle hit-test.
  const inRect = (x, y, x0, y0, x1, y1) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;

  // The four bracket arms (top-left horizontal/vertical, bottom-right
  // horizontal/vertical), expressed as rectangles.
  const tlH = [inset, inset, inset + armLen, inset + thickness - 1];
  const tlV = [inset, inset, inset + thickness - 1, inset + armLen];
  const brH = [size - 1 - inset - armLen, size - 1 - inset - thickness + 1, size - 1 - inset, size - 1 - inset];
  const brV = [size - 1 - inset - thickness + 1, size - 1 - inset - armLen, size - 1 - inset, size - 1 - inset];
  const arms = [tlH, tlV, brH, brV];

  const onArm = (x, y) => arms.some((r) => inRect(x, y, ...r));
  const onArmHalo = (x, y) => {
    if (!haloT) return false;
    for (const [x0, y0, x1, y1] of arms) {
      if (inRect(x, y, x0 - haloT, y0 - haloT, x1 + haloT, y1 + haloT)) return true;
    }
    return false;
  };

  return (x, y) => {
    if (onArm(x, y)) return { ...fg, a: 255 };
    if (halo && onArmHalo(x, y)) return { ...halo, a: 200 };
    return null;
  };
}

const sizes = [16, 32, 128];
const states = [
  { suffix: "", fg: ENABLED_FG, halo: ENABLED_HALO },
  { suffix: "-disabled", fg: DISABLED_FG, halo: null },
];

for (const { suffix, fg, halo } of states) {
  for (const size of sizes) {
    const file = resolve(iconsDir, `icon-${size}${suffix}.png`);
    writeFileSync(file, makePng(size, brackets(size, fg, halo)));
    console.log(`wrote ${file}`);
  }
}
