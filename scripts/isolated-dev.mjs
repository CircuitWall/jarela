#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const stateDir = mkdtempSync(join(tmpdir(), "jarela-isolated-dev-"));
const port = await findFreePort();

console.log(`Isolated Jarela state: ${stateDir}`);
console.log(`Development server: http://localhost:${port}`);
console.log("Temporary state is retained after the server exits.");

const child = spawn(
  process.execPath,
  [nextBin, "dev", "--webpack", "--port", String(port)],
  {
    cwd: repoRoot,
    env: { ...process.env, JARELA_DB_DIR: stateDir },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Could not start the isolated development server: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) console.log(`Development server stopped (${signal}).`);
  process.exitCode = code ?? 1;
});

async function findFreePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine a free development-server port.");
  }
  const { port: freePort } = address;
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return freePort;
}
