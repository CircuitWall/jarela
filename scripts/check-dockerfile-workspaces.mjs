#!/usr/bin/env node
// Every `packages/*` workspace MUST have its package.json COPYed into the
// Docker builder stage before `npm ci`. npm reads each manifest from disk
// to materialize the workspace symlinks under node_modules; a workspace
// whose manifest is absent is simply never linked, and the later
// `next build` fails with "Module not found" for that package.
//
// Nothing else catches this: local builds have all workspaces on disk, and
// the docker build only runs in the release workflow, on a tag — after the
// tag is immutable. Runs as part of `npm run lint`.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");

const workspaces = fs.existsSync(PACKAGES_DIR)
  ? fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .filter((e) => fs.existsSync(path.join(PACKAGES_DIR, e.name, "package.json")))
    .map((e) => e.name)
  : [];

const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
const copied = new Set(
  [...dockerfile.matchAll(/^COPY\s+packages\/(\S+?)\/package\.json/gm)].map((m) => m[1]),
);

const missing = workspaces.filter((name) => !copied.has(name));
const stale = [...copied].filter((name) => !workspaces.includes(name));

for (const name of missing) {
  console.error(
    `\x1b[31m[dockerfile-lint] packages/${name} is not COPYed into the builder stage — `
    + `add "COPY packages/${name}/package.json ./packages/${name}/" before the npm ci line\x1b[0m`,
  );
}
for (const name of stale) {
  console.error(`\x1b[31m[dockerfile-lint] Dockerfile COPYs packages/${name}, which no longer exists\x1b[0m`);
}

if (missing.length > 0 || stale.length > 0) process.exit(1);
console.log(`[dockerfile-lint] ${workspaces.length} workspace manifest(s) COPYed`);
