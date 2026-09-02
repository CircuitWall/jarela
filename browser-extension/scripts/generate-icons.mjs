// Generate browser-extension toolbar icons from a logo mark.
//
// Output families:
// - icon-*: brand-colored logo for light toolbars
// - icon-white-*: white-tinted logo for dark toolbars
// Each family also gets -disabled variants by reducing opacity.
//
// Run (upstream Jarela icons, written in place):
//   node browser-extension/scripts/generate-icons.mjs
//
// Run (rebranded build — see scripts/build-extension.mjs):
//   node browser-extension/scripts/generate-icons.mjs \
//     --logo path/to/mark.png --out dist/browser-extension/icons
//
// `generateIcons()` is exported so build-extension.mjs can call it directly
// rather than shelling out.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

export const DEFAULT_LOGO = resolve(root, "public", "logo-mark-transparent.png");
export const DEFAULT_ICONS_DIR = resolve(here, "..", "icons");

const SIZES = [16, 32, 128];
const PADDING = 0.06;

async function buildLogoBuffer(logoSrc, { white }) {
  const base = sharp(logoSrc);
  if (!white) return base.png({ compressionLevel: 9 }).toBuffer();
  // White variant keeps alpha silhouette while recoloring the mark.
  return base
    .grayscale()
    .tint({ r: 248, g: 250, b: 252 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function writeIcon({ iconsDir, stem, size, suffix, input, opacity, quiet }) {
  const inner = Math.round(size * (1 - PADDING * 2));
  const resized = await sharp(input)
    .resize({ width: inner, height: inner, fit: "inside" })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const outFile = resolve(iconsDir, `${stem}-${size}${suffix}.png`);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, gravity: "center", blend: "over", opacity }])
    .png({ compressionLevel: 9 })
    .toFile(outFile);
  if (!quiet) console.log(`wrote ${outFile}`);
}

export async function generateIcons({
  logo = DEFAULT_LOGO,
  iconsDir = DEFAULT_ICONS_DIR,
  quiet = false,
} = {}) {
  mkdirSync(iconsDir, { recursive: true });
  const colored = await buildLogoBuffer(logo, { white: false });
  const white = await buildLogoBuffer(logo, { white: true });

  for (const size of SIZES) {
    await writeIcon({ iconsDir, stem: "icon", size, suffix: "", input: colored, opacity: 1, quiet });
    await writeIcon({ iconsDir, stem: "icon", size, suffix: "-disabled", input: colored, opacity: 0.52, quiet });
    await writeIcon({ iconsDir, stem: "icon-white", size, suffix: "", input: white, opacity: 1, quiet });
    await writeIcon({ iconsDir, stem: "icon-white", size, suffix: "-disabled", input: white, opacity: 0.52, quiet });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--logo") out.logo = resolve(argv[++i]);
    else if (argv[i] === "--out") out.iconsDir = resolve(argv[++i]);
  }
  return out;
}

// Only run when invoked directly, so importing this module is side-effect free.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  generateIcons(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
