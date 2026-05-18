// Cross-platform launcher for the standalone production server.
//
// `next start` does not work with `output: "standalone"` (Next prints a
// warning and falls back to the dev-style start which can't see the bundled
// chunks). The correct entry point is .next/standalone/server.js, but that
// file reads PORT/HOSTNAME from env and we want sensible defaults that
// match the dev port (4312). Setting env vars inline in package.json
// scripts isn't portable across bash/zsh/PowerShell, so we do it here.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const server = join(process.cwd(), ".next", "standalone", "server.js");
if (!existsSync(server)) {
  console.error(
    `[start] standalone server not built — run \`npm run build\` first.\n  expected: ${server}`,
  );
  process.exit(1);
}

process.env.PORT ||= "4312";
process.env.HOSTNAME ||= "127.0.0.1";

await import(pathToFileURL(server).href);
