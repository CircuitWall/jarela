#!/usr/bin/env node
// Decides which unit tests the pre-commit hook runs for the staged change.
//
// Input (stdin): `git diff --cached --name-status -z` output.
// Output (stdout): NUL-separated tokens. The first is the mode:
//   "none"    – nothing test-relevant staged (docs only)
//   "related" – remaining tokens are files for `vitest related`
//   "full"    – run the whole suite
// CI runs the full suite. Local commits never escalate automatically;
// shared setup, configuration, and deleted modules require CI coverage.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i;
const TEST_EXTENSIONS = [".test.ts", ".test.tsx", ".test.mjs"];

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

// `vitest related` follows imports only; tests that spawn a script (for
// example scripts/jarela-bin.test.mjs) would be missed without this.
function siblingTests(file, exists) {
  if (TEST_FILE.test(file)) return [];
  const stem = file.replace(/\.[^/.]+$/, "");
  return TEST_EXTENSIONS.map((ext) => stem + ext).filter((candidate) => exists(candidate));
}

export function selectTests(entries, { forceFull = false, exists = existsSync } = {}) {
  if (forceFull) return { mode: "full", files: [] };
  const related = [];
  for (const { status, path } of entries) {
    const normalized = path.replace(/\\/g, "/");
    if (IGNORED.some((pattern) => pattern.test(normalized))) continue;
    if (normalized.startsWith(".githooks/")) {
      related.push("scripts/select-precommit-tests.mjs");
      continue;
    }
    if (CI_ONLY_TRIGGERS.some((pattern) => pattern.test(normalized))) continue;
    // `vitest related` can't trace importers of a file that no longer exists.
    if (status === "D") continue;
    if (CODE_EXTENSIONS.test(normalized)) related.push(normalized);
    else related.push(...siblingTests(normalized, exists));
  }
  if (related.length === 0) return { mode: "none", files: [] };
  const files = [];
  for (const file of related) {
    for (const candidate of [file, ...siblingTests(file, exists)]) {
      if (!files.includes(candidate)) files.push(candidate);
    }
  }
  return { mode: "related", files };
}

function main() {
  const raw = readFileSync(0, "utf8");
  const forceFull = process.env.JARELA_PRECOMMIT_FULL_TESTS === "1";
  const { mode, files } = selectTests(parseNameStatus(raw), { forceFull });
  process.stdout.write([mode, ...files].join("\0") + "\0");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
