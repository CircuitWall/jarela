#!/usr/bin/env node
// Build and push the Jarela image to Docker Hub.
//
// Multi-arch (linux/amd64 + linux/arm64) via `docker buildx`. Tags:
//   <repo>:<version>   — exact semver from package.json (or --version)
//   <repo>:<major>     — e.g. 0   (only if version is semver, --no-moving skips)
//   <repo>:<major.minor> — e.g. 0.1
//   <repo>:latest      — unless --no-latest
//
// Usage:
//   node scripts/release-docker.mjs                       # uses package.json version
//   node scripts/release-docker.mjs --version 0.1.0
//   node scripts/release-docker.mjs --repo myuser/jarela  # override Docker Hub repo
//   node scripts/release-docker.mjs --dry-run             # build only, no push
//   node scripts/release-docker.mjs --no-latest           # skip the :latest tag
//   node scripts/release-docker.mjs --platforms linux/amd64
//
// Auth:
//   You must `docker login` (or `docker login -u $DOCKERHUB_USERNAME -p $DOCKERHUB_TOKEN`)
//   before running this. CI uses docker/login-action; see .github/workflows/release.yml.
//
// Default repo: `andrewgewu/jarela` (override with --repo or JARELA_DOCKER_REPO env).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ---------- args ----------
const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = opt("version", pkg.version);
const repo = opt("repo", process.env.JARELA_DOCKER_REPO || "andrewgewu/jarela");
const platforms = opt("platforms", "linux/amd64,linux/arm64");
const dryRun = flag("dry-run");
const noLatest = flag("no-latest");
const noMoving = flag("no-moving");

if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(`[release-docker] refusing to release non-semver version: ${version}`);
  process.exit(1);
}

// ---------- tags ----------
const [major, minor] = version.split(".");
const tags = [`${repo}:${version}`];
if (!noMoving && !version.includes("-")) {
  // Skip moving tags for prereleases like 0.1.0-rc.1.
  tags.push(`${repo}:${major}.${minor}`);
  tags.push(`${repo}:${major}`);
}
if (!noLatest && !version.includes("-")) tags.push(`${repo}:latest`);

console.log(`[release-docker] repo      : ${repo}`);
console.log(`[release-docker] version   : ${version}`);
console.log(`[release-docker] platforms : ${platforms}`);
console.log(`[release-docker] tags      : ${tags.join(", ")}`);
console.log(`[release-docker] dry run   : ${dryRun}`);

// ---------- preflight ----------
function run(cmd, argv, { capture = false } = {}) {
  if (capture) {
    return execFileSync(cmd, argv, { cwd: repoRoot, encoding: "utf8" }).trim();
  }
  const r = spawnSync(cmd, argv, { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[release-docker] ${cmd} ${argv.join(" ")} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

try {
  run("docker", ["--version"], { capture: true });
} catch {
  console.error("[release-docker] docker CLI not found on PATH");
  process.exit(1);
}

// Ensure a buildx builder exists. Create a throwaway one if not.
let hasBuilder = false;
try {
  const out = run("docker", ["buildx", "inspect", "jarela-builder"], { capture: true });
  hasBuilder = /Name:\s+jarela-builder/.test(out);
} catch { /* not created yet */ }
if (!hasBuilder) {
  console.log("[release-docker] creating buildx builder 'jarela-builder'");
  run("docker", ["buildx", "create", "--name", "jarela-builder", "--use", "--bootstrap"]);
} else {
  run("docker", ["buildx", "use", "jarela-builder"]);
}

// ---------- build + push ----------
const buildArgs = [
  "buildx", "build",
  "--platform", platforms,
  "--file", "Dockerfile",
  ...tags.flatMap((t) => ["--tag", t]),
  "--label", `org.opencontainers.image.version=${version}`,
  "--label", `org.opencontainers.image.source=${pkg.repository?.url || pkg.homepage || ""}`,
  "--label", `org.opencontainers.image.revision=${process.env.GITHUB_SHA || ""}`,
  "--label", `org.opencontainers.image.title=Jarela`,
  "--label", `org.opencontainers.image.description=${pkg.description || "Jarela"}`,
  "--label", `org.opencontainers.image.licenses=${pkg.license || "MIT"}`,
  dryRun ? "--load" : "--push",
  ".",
];

// Multi-arch + --load is incompatible (Docker can't load multi-arch into local
// store). For dry runs collapse to the host arch so the build still succeeds.
if (dryRun && platforms.includes(",")) {
  const hostArch = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
  const i = buildArgs.indexOf("--platform");
  buildArgs[i + 1] = hostArch;
  console.log(`[release-docker] dry-run: forcing single platform ${hostArch} (--load is single-arch)`);
}

console.log(`[release-docker] docker ${buildArgs.join(" ")}`);
run("docker", buildArgs);

console.log(dryRun
  ? "[release-docker] dry-run complete (image loaded locally, NOT pushed)"
  : `[release-docker] pushed ${tags.length} tag(s) to ${repo}`);
