#!/usr/bin/env node
// Ratchet for UI data-access debt.
//
// components/ and hooks/ should call the typed api/client (and the documented
// lib/ui/browser-store exception) instead of fetch/localStorage directly.
// Existing call sites are recorded in ui-data-access-baseline.json; counts may
// only decrease. A new file or a higher count fails lint, so the debt cannot
// grow while it is migrated incrementally.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SELF_PATH = url.fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");
const SCAN_DIRS = ["components", "hooks"];
const DIRECT_FETCH = /\bfetch\s*\(/g;
const DIRECT_STORAGE = /\blocalStorage\s*\./g;

function fail(problems, message) {
  problems.push(message);
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolute);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [absolute];
  });
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

export function currentUsage(repoRoot) {
  const usage = { fetch: {}, localStorage: {} };
  for (const dir of SCAN_DIRS) {
    for (const file of walkFiles(path.join(repoRoot, dir))) {
      const relative = path.relative(repoRoot, file).split(path.sep).join("/");
      const source = fs.readFileSync(file, "utf8");
      const fetchCount = count(source, DIRECT_FETCH);
      const storageCount = count(source, DIRECT_STORAGE);
      if (fetchCount > 0) usage.fetch[relative] = fetchCount;
      if (storageCount > 0) usage.localStorage[relative] = storageCount;
    }
  }
  return usage;
}

export function validateUiDataAccess(repoRoot = REPO_ROOT) {
  const problems = [];
  const baselinePath = path.join(repoRoot, "scripts", "ui-data-access-baseline.json");
  if (!fs.existsSync(baselinePath)) {
    fail(problems, "scripts/ui-data-access-baseline.json is missing");
    return problems;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const usage = currentUsage(repoRoot);

  for (const category of ["fetch", "localStorage"]) {
    const allowed = baseline[category] ?? {};
    for (const [file, count] of Object.entries(usage[category])) {
      const limit = allowed[file] ?? 0;
      if (count > limit) {
        fail(
          problems,
          `${file}: ${count} direct ${category} call(s), baseline allows ${limit}; add a typed api/client or lib/ui/browser-store path instead`,
        );
      }
    }
    for (const file of Object.keys(allowed)) {
      if (!usage[category][file]) {
        fail(problems, `scripts/ui-data-access-baseline.json: stale ${category} entry for ${file}; remove or lower it`);
      }
    }
  }

  return problems;
}

export function main() {
  const problems = validateUiDataAccess(REPO_ROOT);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[ui-data-access] ${problem}`);
    console.error(`[ui-data-access] ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  const usage = currentUsage(REPO_ROOT);
  const fetchTotal = Object.values(usage.fetch).reduce((sum, value) => sum + value, 0);
  console.log(`[ui-data-access] no new direct fetch/localStorage usage (${fetchTotal} known fetch call site(s))`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main();
}
