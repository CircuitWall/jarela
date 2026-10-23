#!/usr/bin/env node
// Workflow container images must match the locked @playwright/test version.
// The Playwright image bakes in browser builds for exactly one release; a
// mismatched runner refuses to launch them ("Executable doesn't exist"), and
// nothing else flags the drift until E2E fails on a PR. Runs as part of
// `npm run lint`.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const IMAGE_RE = /mcr\.microsoft\.com\/playwright:([^\s"'#]+)/g;

export function installedPlaywrightVersion(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  return lock.packages?.["node_modules/@playwright/test"]?.version ?? null;
}

/** @param {Record<string, string>} workflows file name → YAML text */
export function checkPlaywrightImages(workflows, version) {
  const errors = [];
  for (const [file, text] of Object.entries(workflows)) {
    for (const match of text.matchAll(IMAGE_RE)) {
      const tag = match[1];
      const tagVersion = /^v(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?$/.exec(tag)?.[1];
      if (tagVersion !== version) {
        errors.push(
          `${file}: Playwright image tag "${tag}" must pin v${version} to match the locked @playwright/test `
          + `(for example mcr.microsoft.com/playwright:v${version}-noble)`,
        );
      }
    }
  }
  return errors;
}

function main() {
  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
  const dir = path.join(repoRoot, ".github", "workflows");
  const workflows = Object.fromEntries(
    fs.readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
  );
  const version = installedPlaywrightVersion(repoRoot);
  const errors = version
    ? checkPlaywrightImages(workflows, version)
    : ["package-lock.json does not lock @playwright/test"];
  for (const error of errors) console.error(`\x1b[31m[workflow-lint] ${error}\x1b[0m`);
  if (errors.length > 0) process.exit(1);
  console.log(`[workflow-lint] Playwright images pinned to v${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) main();
