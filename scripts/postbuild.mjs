// Hydrate .next/standalone/ with assets next build doesn't copy itself.
//
// `output: "standalone"` emits server.js + a minimal node_modules tree, but
// leaves /static and /public empty — the user is expected to copy them in.
// On Windows the install-to-system.ps1 script does this; on macOS/Linux nobody
// did, so `node .next/standalone/server.js` 404'd every static asset and
// `npm start` was the only documented launcher (which doesn't work in
// standalone mode at all). This postbuild step makes `npm run build` produce
// a self-contained runnable bundle on every platform.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(
    "[postbuild] .next/standalone/ missing — is `output: 'standalone'` still set in next.config?",
  );
  process.exit(1);
}

cpSync(join(root, "public"), join(standalone, "public"), { recursive: true, force: true });
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
  force: true,
});

console.log("[postbuild] hydrated .next/standalone/ with public + .next/static");
