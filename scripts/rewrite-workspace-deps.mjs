#!/usr/bin/env node
// Rewrites `workspace:` protocol refs in the root package.json to concrete
// semver ranges resolved from the actual `packages/*` versions. Required
// because npm only rewrites `workspace:` when publishing FROM a workspace
// sub-package — when the root itself depends on workspace packages, npm
// leaves the protocol literal and `npm install @circuitwall/jarela` then
// fails with EUNSUPPORTEDPROTOCOL.
//
// Modes:
//   (default)  Mutate root package.json in place.
//   --check    Exit non-zero if any `workspace:` refs remain (no mutation).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const rootPkgPath = join(repoRoot, "package.json");
const packagesDir = join(repoRoot, "packages");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

function loadWorkspaceVersions() {
  const map = new Map();
  let entries;
  try {
    entries = readdirSync(packagesDir);
  } catch {
    return map;
  }
  for (const entry of entries) {
    const pkgJson = join(packagesDir, entry, "package.json");
    try {
      if (!statSync(pkgJson).isFile()) continue;
    } catch {
      continue;
    }
    const parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
    if (parsed?.name && parsed?.version) {
      map.set(parsed.name, parsed.version);
    }
  }
  return map;
}

function rewriteRange(name, spec, versions) {
  if (!spec.startsWith("workspace:")) return spec;
  const version = versions.get(name);
  if (!version) {
    throw new Error(
      `dependency ${name} uses ${spec} but no matching workspace package was found under packages/*`,
    );
  }
  const tail = spec.slice("workspace:".length);
  if (tail === "" || tail === "*") return version;
  if (tail === "^" || tail === "~") return `${tail}${version}`;
  if (/^[\^~]?\d/.test(tail)) return tail;
  throw new Error(`dependency ${name} has unsupported workspace spec: ${spec}`);
}

function rewriteSection(section, versions, changes) {
  if (!section) return section;
  const out = { ...section };
  for (const [name, spec] of Object.entries(section)) {
    if (typeof spec !== "string") continue;
    if (!spec.startsWith("workspace:")) continue;
    const next = rewriteRange(name, spec, versions);
    out[name] = next;
    changes.push(`${name}: ${spec} → ${next}`);
  }
  return out;
}

const raw = readFileSync(rootPkgPath, "utf8");
const pkg = JSON.parse(raw);
const versions = loadWorkspaceVersions();
const changes = [];

const sections = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
for (const key of sections) {
  if (pkg[key]) pkg[key] = rewriteSection(pkg[key], versions, changes);
}

if (checkOnly) {
  if (changes.length > 0) {
    console.error("[rewrite-workspace-deps] package.json still contains workspace: refs:");
    for (const line of changes) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("[rewrite-workspace-deps] no workspace: refs found, ok");
  process.exit(0);
}

if (changes.length === 0) {
  console.log("[rewrite-workspace-deps] nothing to rewrite");
  process.exit(0);
}

const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const trailing = raw.endsWith("\n") ? "\n" : "";
const serialized = JSON.stringify(pkg, null, 2).replace(/\n/g, eol) + trailing;
writeFileSync(rootPkgPath, serialized);

console.log("[rewrite-workspace-deps] rewrote root package.json:");
for (const line of changes) console.log(`  ${line}`);
