// Hydrate .next/standalone/ with assets next build doesn't copy itself.
//
// `output: "standalone"` emits server.js + a minimal node_modules tree, but
// leaves /static and /public empty — the user is expected to copy them in.
// On Windows the install-to-system.ps1 script does this; on macOS/Linux nobody
// did, so `node .next/standalone/server.js` 404'd every static asset and
// `npm start` was the only documented launcher (which doesn't work in
// standalone mode at all). This postbuild step makes `npm run build` produce
// a self-contained runnable bundle on every platform.

import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalModelAssets } from "../lib/embeddings/local-model-assets.mjs";
import { findStandaloneFootprintProblems, pruneStandaloneFootprint } from "./standalone-footprint.mjs";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(
    "[postbuild] .next/standalone/ missing — is `output: 'standalone'` still set in next.config?",
  );
  process.exit(1);
}

const pruned = pruneStandaloneFootprint(standalone);
if (pruned.length > 0) {
  console.log(`[postbuild] pruned ${pruned.length} unused traced path(s) from .next/standalone/`);
}
const footprintProblems = findStandaloneFootprintProblems(standalone);
if (footprintProblems.length > 0) {
  console.error(`[postbuild] standalone bundle footprint check failed:\n  - ${footprintProblems.join("\n  - ")}`);
  process.exit(1);
}

cpSync(join(root, "public"), join(standalone, "public"), { recursive: true, force: true });
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
  force: true,
});
// The Jarela Local embedding model (~136 MB) is downloaded on first use
// (ADR-0101). Offline/air-gapped builds opt into bundling it.
const bundleModel = process.env.JARELA_BUNDLE_LOCAL_EMBEDDING === "1";
const standaloneAssets = join(standalone, ".jarela-assets");
rmSync(standaloneAssets, { recursive: true, force: true });
if (bundleModel) {
  const assets = join(root, ".jarela-assets", "local-embedding");
  await ensureLocalModelAssets(assets);
  cpSync(assets, join(standaloneAssets, "local-embedding"), { recursive: true, force: true });
}

console.log(
  `[postbuild] hydrated .next/standalone/ with public and .next/static${bundleModel ? " plus the bundled local embedding model" : ""}`,
);
