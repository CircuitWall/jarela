// Generate browser-extension toolbar icons from the real Jarela logo mark.
//
// Output families:
// - icon-*: blue logo for light toolbars
// - icon-white-*: white-tinted logo for dark toolbars
// Each family also gets -disabled variants by reducing opacity.
//
// Run: node browser-extension/scripts/generate-icons.mjs

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const iconsDir = resolve(here, "..", "icons");
const logoSrc = resolve(root, "public", "logo-mark-transparent.png");
mkdirSync(iconsDir, { recursive: true });

const SIZES = [16, 32, 128];
const PADDING = 0.06;

async function buildLogoBuffer({ white }) {
  const base = sharp(logoSrc);
  if (!white) return base.png({ compressionLevel: 9 }).toBuffer();
  // White variant keeps alpha silhouette while recoloring the mark.
  return base
    .grayscale()
    .tint({ r: 248, g: 250, b: 252 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function writeIcon({ stem, size, suffix, input, opacity }) {
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
  console.log(`wrote ${outFile}`);
}

async function run() {
  const blue = await buildLogoBuffer({ white: false });
  const white = await buildLogoBuffer({ white: true });

  for (const size of SIZES) {
    await writeIcon({ stem: "icon", size, suffix: "", input: blue, opacity: 1 });
    await writeIcon({ stem: "icon", size, suffix: "-disabled", input: blue, opacity: 0.52 });
    await writeIcon({ stem: "icon-white", size, suffix: "", input: white, opacity: 1 });
    await writeIcon({ stem: "icon-white", size, suffix: "-disabled", input: white, opacity: 0.52 });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
