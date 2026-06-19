#!/usr/bin/env node
// Brief, non-interactive hint printed after `npm install -g @circuitwall/jarela`.
//
// Safe in CI, non-TTY, root-via-sudo, and source-checkout contexts: any of
// those signals short-circuits to a clean exit 0. postinstall MUST NOT fail
// the install, so the whole body is wrapped in try/catch and we never throw.
//
// Silence with: JARELA_QUIET_POSTINSTALL=1.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");

  // Skip in source checkouts — postinstall also fires on `npm install` in the
  // repo. The published tarball does not include `.git/`.
  if (existsSync(join(root, ".git"))) process.exit(0);

  // Only print on global installs. Local `npm i jarela` (consumed as a lib
  // dependency) and `npx`/`pnpm dlx` invocations stay silent.
  if (process.env.npm_config_global !== "true") process.exit(0);

  if (process.env.JARELA_QUIET_POSTINSTALL === "1") process.exit(0);
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);

  // Don't tease users into installing a per-user service from a root shell —
  // the autostart unit would land in /root/ and never run as them.
  if (typeof process.getuid === "function" && process.getuid() === 0 && process.env.SUDO_USER) {
    process.exit(0);
  }

  const color = (s, code) => process.stdout.isTTY ? `\u001b[${code}m${s}\u001b[0m` : s;
  const bold = (s) => color(s, "1");
  const cyan = (s) => color(s, "36");
  const dim = (s) => color(s, "2");

  process.stdout.write(`
${bold("Jarela installed.")} ${dim("(set JARELA_QUIET_POSTINSTALL=1 to silence)")}

  ${cyan("jarela")}                    ${dim("# first run: offers to register autostart, then starts on :4312")}
  ${cyan("jarela install-service")}    ${dim("# register autostart non-interactively (Windows Task / macOS LaunchAgent / Linux systemd-user)")}
  ${cyan("jarela --help")}             ${dim("# all subcommands")}

Docs: https://github.com/CircuitWall/jarela#readme
`);
} catch {
  // postinstall must never fail the install.
}
process.exit(0);
