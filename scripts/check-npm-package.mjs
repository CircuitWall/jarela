import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

function quote(arg) {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function run(command, args) {
  const executable = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : command;
  const finalArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")]
    : args;
  const result = spawnSync(executable, finalArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${finalArgs.join(" ")} failed (exit ${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

const packJson = run("npm", ["pack", "--json"]);
const pack = JSON.parse(packJson)[0];
const filename = pack.filename;

try {
  const listing = run("tar", ["-tf", filename])
    .split(/\r?\n/)
    .filter(Boolean);

  const required = [
    "package/.next/standalone/server.js",
    "package/.next/standalone/public/manifest.json",
  ];

  for (const entry of required) {
    if (!listing.includes(entry)) {
      throw new Error(`npm tarball is missing required entry: ${entry}`);
    }
  }

  if (!listing.some((entry) => entry.startsWith("package/.next/standalone/.next/static/"))) {
    throw new Error("npm tarball is missing hydrated .next/static assets inside the standalone bundle");
  }

  console.log(`[npm-package] ok: ${filename} contains runnable standalone bundle`);
} finally {
  rmSync(filename, { force: true });
}
