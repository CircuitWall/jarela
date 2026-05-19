#!/usr/bin/env node
// Lint check for ADR-0010: every directory under lib/integrations/ MUST
// contain a manifest.ts, AND that manifest MUST be referenced from
// lib/integrations/registry.ts. Runs as part of `npm run lint`.
//
// Why a separate script: the manifest schema is enforced at runtime by
// validateManifest() (so a malformed manifest fails on first import in
// dev/build). What we cannot catch at runtime is the *missing* case — a
// new integration directory that someone added without remembering to
// author a manifest. This script closes that gap statically.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const INTEGRATIONS_DIR = path.join(REPO_ROOT, "lib", "integrations");
const REGISTRY_PATH = path.join(INTEGRATIONS_DIR, "registry.ts");

function fail(msg) {
  console.error(`[31m[manifest-lint] ${msg}[0m`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`[manifest-lint] ${msg}`);
}

if (!fs.existsSync(INTEGRATIONS_DIR)) {
  fail(`expected ${INTEGRATIONS_DIR} to exist`);
  process.exit(process.exitCode || 1);
}

const entries = fs.readdirSync(INTEGRATIONS_DIR, { withFileTypes: true });
const dirs = entries
  .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
  .map((e) => e.name);

if (dirs.length === 0) {
  ok("no integration subdirectories — nothing to check");
  process.exit(0);
}

let registrySrc = "";
try {
  registrySrc = fs.readFileSync(REGISTRY_PATH, "utf8");
} catch {
  fail(`registry not found at ${REGISTRY_PATH}`);
  process.exit(process.exitCode || 1);
}

let problems = 0;
for (const dir of dirs) {
  const manifestPath = path.join(INTEGRATIONS_DIR, dir, "manifest.ts");
  if (!fs.existsSync(manifestPath)) {
    fail(`lib/integrations/${dir}/ has no manifest.ts (required by ADR-0010)`);
    problems++;
    continue;
  }

  const src = fs.readFileSync(manifestPath, "utf8");
  // Cheap sanity checks — the runtime zod schema does the deep work.
  const exportMatch = src.match(/export\s+const\s+(\w+Manifest)\s*:\s*IntegrationManifest\b/);
  if (!exportMatch) {
    fail(
      `lib/integrations/${dir}/manifest.ts must export a const named *Manifest typed as IntegrationManifest`,
    );
    problems++;
    continue;
  }
  const exportName = exportMatch[1];

  const importPattern = new RegExp(
    `import\\s*\\{\\s*${exportName}\\s*\\}\\s*from\\s*["']@/lib/integrations/${dir}/manifest["']`,
  );
  if (!importPattern.test(registrySrc)) {
    fail(
      `lib/integrations/${dir}/manifest.ts exports ${exportName} but it is not imported in registry.ts`,
    );
    problems++;
    continue;
  }

  const arrayPattern = new RegExp(`\\b${exportName}\\b`, "g");
  const occurrences = (registrySrc.match(arrayPattern) ?? []).length;
  // Expect: 1 in the import line + 1 in the RAW array.
  if (occurrences < 2) {
    fail(
      `${exportName} is imported in registry.ts but not added to the RAW array`,
    );
    problems++;
    continue;
  }
}

if (problems === 0) {
  ok(`${dirs.length} integration manifest(s) verified`);
  process.exit(0);
}
process.exit(1);
