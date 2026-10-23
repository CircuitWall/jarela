import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("./jarela-bin.mjs", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function run(...args) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, JARELA_DISABLE_UPDATE_CHECK: "1", JARELA_NO_FIRST_RUN_PROMPT: "1" },
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("jarela CLI entry point", () => {
  it.each(["--version", "-v", "version"])("prints the installed version for %s so upgrades can be verified", (flag) => {
    const r = run(flag);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it("prints help with every subcommand", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    for (const sub of ["start", "update", "install-service", "uninstall-service", "--version"]) {
      expect(r.stdout).toContain(sub);
    }
  });

  it("rejects unknown commands with exit code 2 and shows help", () => {
    const r = run("upgrade-everything");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown command: upgrade-everything");
    expect(r.stdout).toContain("Usage:");
  });
});
