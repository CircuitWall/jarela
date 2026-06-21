import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const rootPkgPath = resolve(repoRoot, "package.json");

// Mirror what `npm publish` does via the prepublishOnly hook so the packed
// tarball reflects what end users will actually receive.
const originalRootPkg = readFileSync(rootPkgPath, "utf8");
let filename = null;
try {
  run("node", ["scripts/rewrite-workspace-deps.mjs"]);

  const packJson = run("npm", ["pack", "--json"]);
  const pack = JSON.parse(packJson)[0];
  filename = pack.filename;

  const listing = run("tar", ["-tf", filename])
    .split(/\r?\n/)
    .filter(Boolean);

  const required = [
    "package/.next/standalone/server.js",
    "package/.next/standalone/public/manifest.json",
    "package/package.json",
    "package/scripts/jarela-bin.mjs",
    "package/scripts/update.mjs",
    "package/scripts/service-install.mjs",
    "package/scripts/first-run-prompt.mjs",
    "package/scripts/start-prod.mjs",
  ];

  for (const entry of required) {
    if (!listing.includes(entry)) {
      throw new Error(`npm tarball is missing required entry: ${entry}`);
    }
  }

  if (!listing.some((entry) => entry.startsWith("package/.next/standalone/.next/static/"))) {
    throw new Error("npm tarball is missing hydrated .next/static assets inside the standalone bundle");
  }

  const packedManifest = run("tar", ["-xOf", filename, "package/package.json"]);
  if (/"workspace:/i.test(packedManifest)) {
    throw new Error(
      "npm tarball contains literal `workspace:` dependency specs — end-user `npm install` would fail with EUNSUPPORTEDPROTOCOL",
    );
  }

  console.log(`[npm-package] ok: ${filename} contains runnable standalone bundle`);
} finally {
  writeFileSync(rootPkgPath, originalRootPkg);
  if (filename) rmSync(filename, { force: true });
}
