// Generates Jarela logo asset variants from public/logo-source.png.
//
// Output (all PNG unless noted):
//   public/logo-mark.png                   320 wide, white bg          (README hero)
//   public/logo-mark-transparent.png       512 wide, navy J  / alpha   (in-app, light UI)
//   public/logo-mark-transparent-dark.png  512 wide, sky  J  / alpha   (in-app, dark  UI)
//
//   ── Dark-theme set (default — recommended for unknown wallpaper) ──
//   public/icon-192.png                    192x192, navy + glowing J   (PWA dark)
//   public/icon-512.png                    512x512, navy + glowing J   (PWA dark)
//   public/icon-192-maskable.png           192x192, navy + glowing J   (PWA maskable dark)
//   public/icon-512-maskable.png           512x512, navy + glowing J   (PWA maskable dark)
//   public/apple-touch-icon.png            180x180, navy + glowing J   (iOS home screen, default)
//
//   ── Light-theme companion set ──
//   public/icon-192-light.png              192x192, platinum + navy J  (PWA light)
//   public/icon-512-light.png              512x512, platinum + navy J  (PWA light)
//   public/icon-192-maskable-light.png     192x192, platinum + navy J  (PWA maskable light)
//   public/icon-512-maskable-light.png     512x512, platinum + navy J  (PWA maskable light)
//   public/apple-touch-icon-light.png      180x180, platinum + navy J  (iOS, manual opt-in)
//
//   ── Favicons ──
//   public/favicon.svg                     theme-aware SVG (prefers-color-scheme)
//   public/favicon-32.png                  32x32,  transparent bg     (site icon, modern)
//   public/favicon-16.png                  16x16,  transparent bg     (site icon, legacy)
//   public/favicon.ico                     multi-res ICO (32 + 16)    (browsers)
//
// Run: node scripts/gen-logo.mjs

import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = new URL("../public/", import.meta.url);
const SRC = new URL("logo-source.png", PUBLIC).pathname.replace(/^\//, "");
const out = (name) => new URL(name, PUBLIC).pathname.replace(/^\//, "");

// ---- "glowing J on navy" treatment (PWA / Apple touch icon) ----------------
//
// The PWA install surfaces (iOS home screen, Android drawer, Chrome's "add
// to home screen" preview) sit on top of a user's wallpaper. A light-on-
// white app icon disappears there. Use a near-black navy squircle with a
// luminous sky-tinted J and a soft cyan halo so the icon reads at small
// sizes against any background.

const NAVY_BG = { r: 10, g: 14, b: 26, alpha: 1 };       // #0a0e1a
const NAVY_BG_INNER = { r: 26, g: 34, b: 64, alpha: 1 }; // #1a2240
const GLOW = { r: 125, g: 211, b: 252 };                 // sky-300 #7dd3fc
const LETTER_FILL = { r: 224, g: 242, b: 254 };          // sky-100 #e0f2fe

// Light-theme palette: warm platinum background, deep navy J that matches
// the original logo, soft sky-blue glow. Mirror image of the dark set so
// the two read as a pair.
const LIGHT_BG = { r: 248, g: 250, b: 252, alpha: 1 };       // slate-50 #f8fafc
const LIGHT_BG_INNER = { r: 224, g: 232, b: 244, alpha: 1 }; // soft cool #e0e8f4
const LIGHT_GLOW = { r: 56, g: 132, b: 224 };                // sky-500-ish #3884e0
const LIGHT_LETTER = { r: 15, g: 23, b: 56 };                // deep navy #0f1738

// Recolor the J silhouette: keep the alpha channel as a mask, replace RGB
// with a flat luminous tint.
async function tintedMark(tint) {
  const { data, info } = await sharp(await transparentMarkPng())
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = tint.r;
    data[i + 1] = tint.g;
    data[i + 2] = tint.b;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");

// Build a glow icon: SVG radial-gradient background (smooth falloff at any
// size — no visible disc seam) + tinted J + two-stop glow halo. The palette
// argument lets us reuse the same composition for both the dark (navy/sky)
// and light (platinum/navy) variants so the two read as a sibling pair.
// `masked=true` skips the iOS-style rounded-square clip so the home-screen
// shape mask on Android can do its own crop without cutting into the J.
async function glowIcon({ size, masked = false, palette }) {
  const { bg, bgInner, glow, letter, glowBlend = "screen" } = palette;
  const inner = Math.round(size * (masked ? 0.6 : 0.68));
  const fitted = await sharp(await tintedMark(letter))
    .resize({ width: inner, height: inner, fit: "inside" })
    .png()
    .toBuffer();

  const glowMark = await tintedMark(glow);
  const glowFitted = await sharp(glowMark)
    .resize({ width: inner, height: inner, fit: "inside" })
    .png()
    .toBuffer();
  const glowNear = await sharp(glowFitted).blur(Math.max(2, size / 64)).png().toBuffer();
  const glowFar = await sharp(glowFitted).blur(Math.max(6, size / 24)).png().toBuffer();

  const midColor = hex({
    r: Math.round((bg.r + bgInner.r) / 2),
    g: Math.round((bg.g + bgInner.g) / 2),
    b: Math.round((bg.b + bgInner.b) / 2),
  });
  const bgSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs>
        <radialGradient id="g" cx="50%" cy="42%" r="75%">
          <stop offset="0%"  stop-color="${hex(bgInner)}"/>
          <stop offset="55%" stop-color="${midColor}"/>
          <stop offset="100%" stop-color="${hex(bg)}"/>
        </radialGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
    </svg>`,
  );
  let canvas = await sharp(bgSvg).png().toBuffer();

  if (!masked) {
    const radius = Math.round(size * 0.22);
    const maskSvg = Buffer.from(
      `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
    );
    canvas = await sharp(canvas)
      .composite([{ input: maskSvg, blend: "dest-in" }])
      .png()
      .toBuffer();
  }

  return sharp(canvas)
    .composite([
      // `screen` lifts the glow against dark navy; on light bg we use
      // `multiply` so the blurred letter darkens-toward-blue instead of
      // washing out invisibly.
      { input: glowFar, gravity: "center", blend: glowBlend },
      { input: glowNear, gravity: "center", blend: glowBlend },
      { input: fitted, gravity: "center" },
    ])
    .png({ compressionLevel: 9 });
}

const PALETTE_DARK = {
  bg: NAVY_BG, bgInner: NAVY_BG_INNER,
  glow: GLOW, letter: LETTER_FILL,
  glowBlend: "screen",
};
const PALETTE_LIGHT = {
  bg: LIGHT_BG, bgInner: LIGHT_BG_INNER,
  glow: LIGHT_GLOW, letter: LIGHT_LETTER,
  glowBlend: "multiply",
};

// Back-compat shim — the dark navy icon stays the default for any external
// caller still asking for the old function name.
async function navyGlowIcon({ size, masked = false }) {
  return glowIcon({ size, masked, palette: PALETTE_DARK });
}

// ---- main ------------------------------------------------------------------

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

  // 2. Transparent-bg marks for in-app rendering. Two color variants so
  //    the React `<Logo />` component can swap on the active theme:
  //    - logo-mark-transparent.png      navy J  (light UI surfaces)
  //    - logo-mark-transparent-dark.png sky  J  (dark  UI surfaces)
  const markPng = await transparentMarkPng();
  await sharp(markPng)
    .resize({ width: 512 })
    .png({ compressionLevel: 9 })
    .toFile(out("logo-mark-transparent.png"));
  await sharp(await tintedMark(LETTER_FILL))
    .resize({ width: 512 })
    .png({ compressionLevel: 9 })
    .toFile(out("logo-mark-transparent-dark.png"));

  // 3. PWA app icons — dark navy squircle with glowing J (default set).
  //    Reads against any wallpaper on iOS/Android install surfaces;
  //    light-on-white versions disappeared on dark/photo home screens.
  for (const size of [192, 512]) {
    await (await glowIcon({ size, palette: PALETTE_DARK })).toFile(out(`icon-${size}.png`));
  }
  // 3b. Light-theme companion set — same composition, platinum bg +
  //     navy J + sky-blue halo. Used in the manifest's theme-aware
  //     icon list and by anyone who hand-picks a light-tile icon.
  for (const size of [192, 512]) {
    await (await glowIcon({ size, palette: PALETTE_LIGHT })).toFile(out(`icon-${size}-light.png`));
  }

  // 4. Maskable variants — same artwork, no rounded-corner clip so the
  //    platform's shape mask (Android adaptive icon, etc.) crops to its
  //    own outline without cutting the rounded squircle twice.
  for (const size of [192, 512]) {
    await (await glowIcon({ size, masked: true, palette: PALETTE_DARK })).toFile(out(`icon-${size}-maskable.png`));
  }
  for (const size of [192, 512]) {
    await (await glowIcon({ size, masked: true, palette: PALETTE_LIGHT })).toFile(out(`icon-${size}-maskable-light.png`));
  }

  // 5. Apple touch icon. iOS reads ONE apple-touch-icon and ignores
  //    prefers-color-scheme, so the default keeps the dark navy
  //    treatment (works on every home-screen wallpaper). The light
  //    variant ships alongside for users who explicitly opt in via
  //    <link rel="apple-touch-icon" media="(prefers-color-scheme: light)">.
  await (await glowIcon({ size: 180, palette: PALETTE_DARK })).toFile(out("apple-touch-icon.png"));
  await (await glowIcon({ size: 180, palette: PALETTE_LIGHT })).toFile(out("apple-touch-icon-light.png"));

  // 6. Favicons — site icons in the browser tab. The PNG fallbacks stay
  //    transparent so they sit on any browser-chrome color. The SVG
  //    favicon below is the one that flips with the user's theme.
  await (await squareIcon({ size: 32 })).toFile(out("favicon-32.png"));
  await (await squareIcon({ size: 16 })).toFile(out("favicon-16.png"));

  // 6b. Theme-aware SVG favicon. Browsers that support
  //     <link rel="icon" type="image/svg+xml"> evaluate
  //     prefers-color-scheme in the SVG's own <style> at render time, so
  //     the same file flips between a navy J on transparent (light UI
  //     surfaces) and a sky-tinted J on transparent (dark UI surfaces).
  //     Falls back to the PNG/ICO entries for older browsers.
  const navyHex = hex(LIGHT_LETTER);
  const skyHex = hex({ r: 224, g: 242, b: 254 });
  // Embed the trimmed mark as a base64 PNG inside the SVG and apply CSS
  // filters keyed to prefers-color-scheme. CSS filter is the only way to
  // re-tint a raster <image> without shipping two payloads.
  const faviconSrc = await sharp(markPng).resize({ width: 128 }).png({ compressionLevel: 9 }).toBuffer();
  const faviconMeta = await sharp(faviconSrc).metadata();
  const faviconB64 = faviconSrc.toString("base64");
  const favSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${faviconMeta.width} ${faviconMeta.height}" width="${faviconMeta.width}" height="${faviconMeta.height}">
  <style>
    /* Default = dark UI: light sky tint. */
    image { filter: brightness(0) saturate(100%) invert(95%) sepia(8%) saturate(380%) hue-rotate(180deg); }
    /* Light UI: keep the deep navy mark. */
    @media (prefers-color-scheme: light) {
      image { filter: none; }
    }
  </style>
  <title>Jarela (${navyHex} / ${skyHex})</title>
  <image href="data:image/png;base64,${faviconB64}" width="${faviconMeta.width}" height="${faviconMeta.height}"/>
</svg>
`;
  writeFileSync(out("favicon.svg"), favSvg);

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
