#!/usr/bin/env node
// Selects staged unit tests and direct sibling unit tests for pre-commit.
//
// Input (stdin): `git diff --cached --name-status -z` output.
// Output (stdout): NUL-separated tokens. The first is the mode:
//   "none" – no directly associated unit tests are available
//   "unit" – remaining tokens are unit-test files to run directly
// CI handles transitive coverage, shared setup/configuration, and the full suite.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i;
const TEST_EXTENSIONS = [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".test.mjs", ".test.cjs"];

// Files that change how every test runs (config, setup, deps, toolchain).
const CI_ONLY_TRIGGERS = [
  /^vitest\.config\.[cm]?[jt]s$/,
  /^tests\/setup[^/]*\.[cm]?[jt]sx?$/,
  /^package(?:-lock)?\.json$/,
  /(?:^|\/)package\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
];

// Files no test reads.
const IGNORED = [/^docs\//, /^[^/]+\.md$/, /^\.github\/.*\.md$/];

export function parseNameStatus(raw) {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const entries = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = tokens[i++];
      const to = tokens[i++];
      if (from === undefined || to === undefined) break;
      // A rename removes the old path; importers of it must be re-checked.
      entries.push({ status: "D", path: from }, { status: "A", path: to });
    } else {
      const path = tokens[i++];
      if (path === undefined) break;
      entries.push({ status: kind, path });
    }
  }
  return entries;
}

function siblingTests(file, exists) {
  if (TEST_FILE.test(file)) return [];
  const stem = file.replace(/\.[^/.]+$/, "");
  return TEST_EXTENSIONS.map((ext) => stem + ext).filter((candidate) => exists(candidate));
}

export function selectTests(entries, { exists = existsSync } = {}) {
  const files = [];
  for (const { status, path } of entries) {
    const normalized = path.replace(/\\/g, "/");
    if (IGNORED.some((pattern) => pattern.test(normalized))) continue;
    if (normalized.startsWith(".githooks/")) {
      files.push(...siblingTests("scripts/select-precommit-tests.mjs", exists));
      continue;
    }
    if (CI_ONLY_TRIGGERS.some((pattern) => pattern.test(normalized))) continue;
    if (status === "D") continue;
    if (TEST_FILE.test(normalized)) files.push(normalized);
    else files.push(...siblingTests(normalized, exists));
  }
  return files.length === 0
    ? { mode: "none", files: [] }
    : { mode: "unit", files: [...new Set(files)] };
}

function main() {
  const raw = readFileSync(0, "utf8");
  const { mode, files } = selectTests(parseNameStatus(raw));
  process.stdout.write([mode, ...files].join("\0") + "\0");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
