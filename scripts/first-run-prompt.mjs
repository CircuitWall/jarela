// First-run interactive prompt offered by `jarela [start]` when no autostart
// is registered yet. Inert in non-interactive contexts so the same binary
// works in CI, pipes, Docker, sudo, and headless service envs.

import { createInterface } from "node:readline/promises";
import { isInstalled, install } from "./service-install.mjs";

/**
 * Returns true when the calling shell looks safe to prompt in:
 * both stdio are TTYs, no CI signal, not running as root via sudo, and the
 * opt-out env var is unset.
 */
export function shouldPromptForServiceInstall({
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : null,
} = {}) {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (env.JARELA_NO_FIRST_RUN_PROMPT === "1") return false;
  if (env.CI || env.CONTINUOUS_INTEGRATION) return false;
  if (getuid && getuid() === 0 && env.SUDO_USER) return false;
  return true;
}

/**
 * If autostart is not yet registered and the shell is interactive, offer to
 * install it. Returns true when the service was just installed (caller should
 * exit, because the autostart unit already spawned a Jarela instance on the
 * service port and the foreground process would collide with it).
 */
export async function maybePromptServiceInstall({
  log = console.log,
  detect = isInstalled,
  run = install,
} = {}) {
  if (!shouldPromptForServiceInstall()) return false;
  if (detect()) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = (await rl.question(
      "\nJarela isn't registered as an autostart service yet.\n" +
      "Install autostart now so it runs at login? [Y/n] ",
    )).trim().toLowerCase();
  } finally {
    rl.close();
  }

  const yes = answer === "" || answer === "y" || answer === "yes";
  if (!yes) {
    log("Skipping. Run `jarela install-service` later to enable autostart.");
    return false;
  }

  try {
    run();
    log("");
    log("Jarela is running in the background as a user service.");
    log("Open http://127.0.0.1:4312 in your browser.");
    log("To stop autostart: jarela uninstall-service");
    return true;
  } catch (e) {
    log(`Service install failed: ${e?.message ?? e}`);
    log("Continuing with foreground start. Re-run `jarela install-service` to retry.");
    return false;
  }
}
