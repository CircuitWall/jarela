// Build a (optionally rebranded) copy of the browser extension.
//
// The extension is loaded unpacked and its MV3 manifest + icons are static
// files, so — unlike the web app, which reads NEXT_PUBLIC_APP_* at build
// time — rebranding it needs a packaging step.
//
// Usage:
//   node scripts/build-extension.mjs                       # upstream build
//   node scripts/build-extension.mjs --brand brand.json     # rebranded build
//   node scripts/build-extension.mjs --out dist/my-ext
//
// brand.json (all keys optional):
//   {
//     "name": "Acme Assistant",
//     "shortName": "Acme",
//     "description": "Browser companion for Acme Assistant: …",
//     "accentColor": "#7c3aed",
//     "logo": "./brand/mark.png"
//   }
//
// With no brand file the output is byte-equivalent to the in-tree
// extension — `npm run test` asserts that, so the two can't drift.
//
// NOT rebrandable on purpose: the upstream credit (UPSTREAM_NAME /
// UPSTREAM_URL in browser-extension/lib/brand.mjs) is never templated, so
// every build keeps crediting the upstream project.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const SRC = resolve(root, "browser-extension");
const DEFAULT_OUT = resolve(root, "dist", "browser-extension");

// Mirrors the defaults in browser-extension/lib/brand.mjs.
export const UPSTREAM_BRAND = Object.freeze({
  name: "Jarela",
  shortName: "Jarela",
  description:
    "Browser companion for Jarela: pick page elements, fill fields, rewrite text, and open the side panel.",
  accentColor: "#3b82f6",
});

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function resolveBrand(raw) {
  const b = { ...UPSTREAM_BRAND };
  if (!raw || typeof raw !== "object") return b;

  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(raw.name);
  b.name = name ?? b.name;
  // shortName defaults to the (possibly overridden) name, not to "Jarela".
  b.shortName = str(raw.shortName) ?? b.name;
  // Only synthesize a description when the fork actually renamed the app —
  // otherwise an empty brand.json would clobber the upstream description.
  b.description = str(raw.description) ?? (name ? `Browser companion for ${name}.` : b.description);

  const accent = str(raw.accentColor);
  if (accent) {
    if (!HEX.test(accent)) {
      throw new Error(`brand.accentColor must be a hex color, got: ${accent}`);
    }
    b.accentColor = accent;
  }
  return b;
}

// The manifest fields that carry a product name. Everything else in
// manifest.json (permissions, entry points, commands' key bindings) is
// build-invariant.
export function brandManifest(manifest, brand) {
  const out = structuredClone(manifest);
  out.name = brand.name;
  out.description = brand.description;
  if (out.action) out.action.default_title = `Capture an element to ${brand.name}`;
  const fill = out.commands?.["fill-focused-field"];
  if (fill) fill.description = `${brand.name}: open fill menu on focused field`;
  return out;
}

export function renderBrandModule(brand, template) {
  // Rewrite only the BRAND literal; the upstream constants and the helper
  // functions below it are copied through untouched.
  const marker = "export const BRAND = Object.freeze({";
  const start = template.indexOf(marker);
  if (start === -1) throw new Error("brand.mjs: BRAND literal not found");
  const end = template.indexOf("});", start);
  if (end === -1) throw new Error("brand.mjs: unterminated BRAND literal");

  const literal = [
    marker,
    `  name: ${JSON.stringify(brand.name)},`,
    `  shortName: ${JSON.stringify(brand.shortName)},`,
    `  description: ${JSON.stringify(brand.description)},`,
    `  accentColor: ${JSON.stringify(brand.accentColor)},`,
    "",
  ].join("\n");

  return template.slice(0, start) + literal + template.slice(end);
}

export async function buildExtension({ brandFile = null, outDir = DEFAULT_OUT, quiet = false } = {}) {
  const raw = brandFile ? JSON.parse(readFileSync(brandFile, "utf8")) : null;
  const brand = resolveBrand(raw);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Copy the tree, minus test files and the icon generator (dev-only).
  cpSync(SRC, outDir, {
    recursive: true,
    filter: (src) => !/\.test\.mjs$/.test(src) && !src.endsWith("browser-extension/scripts"),
  });

  const manifest = JSON.parse(readFileSync(resolve(SRC, "manifest.json"), "utf8"));
  writeFileSync(
    resolve(outDir, "manifest.json"),
    `${JSON.stringify(brandManifest(manifest, brand), null, 2)}\n`,
  );

  const template = readFileSync(resolve(SRC, "lib", "brand.mjs"), "utf8");
  writeFileSync(resolve(outDir, "lib", "brand.mjs"), renderBrandModule(brand, template));

  // Regenerate toolbar icons from the brand logo. Skipped for upstream
  // builds so the committed icons are copied through byte-for-byte.
  const logo = typeof raw?.logo === "string" && raw.logo.trim() ? resolve(dirname(brandFile), raw.logo) : null;
  if (logo) {
    if (!existsSync(logo)) throw new Error(`brand.logo not found: ${logo}`);
    const { generateIcons } = await import("../browser-extension/scripts/generate-icons.mjs");
    await generateIcons({ logo, iconsDir: resolve(outDir, "icons"), quiet });
  }

  if (!quiet) {
    console.log(`Built ${brand.name} extension → ${outDir}`);
    if (!logo) console.log("  (no brand.logo set — kept the upstream icon set)");
  }
  return { brand, outDir };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--brand") out.brandFile = resolve(argv[++i]);
    else if (argv[i] === "--out") out.outDir = resolve(argv[++i]);
    else if (argv[i] === "--quiet") out.quiet = true;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  buildExtension(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
