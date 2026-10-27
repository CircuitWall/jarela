#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(repoRoot, "docs", "architecture-patterns.json");

function fail(message) {
  console.error(`[architecture-patterns] ${message}`);
  process.exitCode = 1;
}

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
} catch (error) {
  fail(`could not read or parse docs/architecture-patterns.json: ${error.message}`);
  process.exit(1);
}

if (
  !catalog
  || typeof catalog !== "object"
  || catalog.schemaVersion !== 1
  || typeof catalog.purpose !== "string"
  || !Array.isArray(catalog.patterns)
  || catalog.patterns.length === 0
) {
  fail("catalog must be an object with schemaVersion 1, a purpose, and a non-empty patterns array");
  process.exit(1);
}

const ids = new Set();
let referenceCount = 0;
for (const [index, pattern] of catalog.patterns.entries()) {
  const label = `patterns[${index}]`;
  if (
    !pattern
    || typeof pattern.id !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pattern.id)
    || typeof pattern.operation !== "string"
    || !Array.isArray(pattern.canonicalSources)
    || pattern.canonicalSources.length === 0
    || !Array.isArray(pattern.validationSources)
    || pattern.validationSources.length === 0
    || !Array.isArray(pattern.exceptions)
    || !pattern.exceptions.every((exception) => typeof exception === "string")
  ) {
    fail(`${label} must define id, operation, canonicalSources, validationSources, and exceptions`);
    continue;
  }
  if (ids.has(pattern.id)) fail(`duplicate pattern id "${pattern.id}"`);
  ids.add(pattern.id);

  for (const reference of [...pattern.canonicalSources, ...pattern.validationSources]) {
    if (
      typeof reference !== "string"
      || reference.length === 0
      || path.isAbsolute(reference)
      || reference.split(/[\\/]/).includes("..")
    ) {
      fail(`${pattern.id}: reference must be a repository-relative path: ${reference}`);
      continue;
    }
    referenceCount++;
    if (!fs.existsSync(path.join(repoRoot, reference))) {
      fail(`${pattern.id}: referenced file does not exist: ${reference}`);
    }
  }
}

if (process.exitCode) process.exit(1);
console.log(`[architecture-patterns] ${ids.size} patterns and ${referenceCount} file references verified`);
