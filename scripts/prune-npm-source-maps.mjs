import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const standaloneRoot = resolve(".next", "standalone");
if (!existsSync(standaloneRoot)) {
  throw new Error(".next/standalone is missing; run `npm run build` before preparing the npm package");
}

let removed = 0;
function pruneSourceMaps(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneSourceMaps(path);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      rmSync(path);
      removed++;
    }
  }
}

pruneSourceMaps(standaloneRoot);
console.log(`[npm-package] removed ${removed} standalone source maps`);
