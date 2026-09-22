import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const publicDir = path.join(root, "public");
const docsAssetsDir = path.join(root, "docs", "assets");

const candidates = [
  "logo.svg",
  "logo-mark-transparent.png",
  "logo-mark-transparent-dark.png",
  "icon-512.png",
  "icon-512-light.png",
  "favicon.svg",
  "favicon-32.png",
  "favicon-16.png",
  "apple-touch-icon.png",
  "apple-touch-icon-light.png",
];

mkdirSync(docsAssetsDir, { recursive: true });

for (const name of candidates) {
  const src = path.join(publicDir, name);
  const dst = path.join(docsAssetsDir, name);
  if (!existsSync(src)) continue;
  cpSync(src, dst, { force: true, recursive: false });
}

// Preserve existing docs asset directories for custom screenshots or diagrams.
for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const srcDir = path.join(publicDir, entry.name);
  const dstDir = path.join(docsAssetsDir, entry.name);
  if (existsSync(srcDir)) {
    cpSync(srcDir, dstDir, { recursive: true, force: true });
  }
}

console.log(`Synced ${candidates.length} static assets from public/ to docs/assets/`);
