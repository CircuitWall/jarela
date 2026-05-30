#!/usr/bin/env node

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DEFAULT_MARKER = join(
  process.cwd(),
  ".next",
  "standalone",
  ".next",
  "static",
  ".jarela-client-optimized.json",
);

function normalize(p) {
  return p.split(sep).join("/");
}

async function listJsFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function looksAlreadyMinified(code) {
  const lines = code.split(/\r?\n/);
  let maxLine = 0;
  for (const line of lines) {
    if (line.length > maxLine) maxLine = line.length;
  }
  return lines.length <= 25 && maxLine >= 600;
}

export async function optimizeClientChunksOnce(opts = {}) {
  const standaloneRoot = opts.standaloneRoot ?? join(process.cwd(), ".next", "standalone");
  const chunksRoot = opts.chunksRoot ?? join(standaloneRoot, ".next", "static", "chunks");
  const markerPath = opts.markerPath ?? DEFAULT_MARKER;
  const enabled = opts.enabled ?? process.env.JARELA_PREFLIGHT_OPTIMIZE_CLIENT === "1";

  if (!enabled) return;
  if (!existsSync(chunksRoot)) return;

  let pkgVersion = "unknown";
  try {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    pkgVersion = String(pkg.version || "unknown");
  } catch {
    // Non-fatal. We still optimize and stamp with "unknown".
  }

  if (existsSync(markerPath) && process.env.JARELA_FORCE_PREFLIGHT_OPTIMIZE !== "1") {
    try {
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker?.version === pkgVersion) {
        return;
      }
    } catch {
      // Corrupt marker: continue and regenerate.
    }
  }

  const terser = require("next/dist/compiled/terser");
  const minify = terser?.minify;
  if (typeof minify !== "function") {
    console.warn("[preflight-optimize] terser unavailable; skipping optimization.");
    return;
  }

  const jsFiles = await listJsFiles(chunksRoot);
  let optimized = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of jsFiles) {
    let code;
    try {
      code = await readFile(file, "utf8");
    } catch {
      failed += 1;
      continue;
    }

    if (looksAlreadyMinified(code)) {
      skipped += 1;
      continue;
    }

    try {
      const result = await minify(code, {
        compress: true,
        mangle: true,
        sourceMap: false,
        format: { comments: false },
      });
      if (!result?.code || result.code.length >= code.length) {
        skipped += 1;
        continue;
      }
      await writeFile(file, result.code, "utf8");
      optimized += 1;
    } catch {
      failed += 1;
    }
  }

  await mkdir(join(standaloneRoot, ".next", "static"), { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        version: pkgVersion,
        optimized,
        skipped,
        failed,
        chunksRoot: normalize(relative(process.cwd(), chunksRoot)),
        optimizedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    `[preflight-optimize] complete: optimized=${optimized}, skipped=${skipped}, failed=${failed}`,
  );
}
