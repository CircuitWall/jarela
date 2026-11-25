#!/usr/bin/env node
// Lint check for the HTTP API contract.
//
// docs/api.md defines the contract by JSDoc marker:
//   @public           — stable app API, must be documented here
//   @public-internal  — stable for the paired browser extension, documented here
//   (none)            — UI-internal, may change without notice
//
// This script verifies both directions so the page and the route files cannot
// drift apart again:
//   1. Every @public / @public-internal route appears in docs/api.md.
//   2. Every documented endpoint heading resolves to a route file and that
//      file carries one of the two public markers.
//   3. A @public route is not also listed as out-of-scope.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SELF_PATH = url.fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");

const PATH_TOKEN = /\/api\/v1\/[A-Za-z0-9_\[\]{}<>?=&|.\/-]*/g;

function fail(problems, message) {
  problems.push(message);
}

export function classifyRoute(source) {
  if (/@public-internal\b/.test(source)) return "public-internal";
  if (/@public(?!-)\b/.test(source)) return "public";
  return "internal";
}

export function normalizeApiPath(value) {
  return value
    .split("?")[0]
    .split("#")[0]
    .replace(/\{[^}]+\}/g, (match) => `[${match.slice(1, -1)}]`)
    .replace(/\/$/, "");
}

export function routePathForFile(repoRoot, file) {
  return `/${path
    .relative(repoRoot, file)
    .replace(/\\/g, "/")
    .replace(/^app\//, "")
    .replace(/\/route\.ts$/, "")}`;
}

export function extractApiPaths(source) {
  const found = new Set();
  for (const match of source.matchAll(PATH_TOKEN)) {
    const value = match[0].replace(/[.,;:]+$/, "");
    if (!value || value.endsWith("/...")) continue;
    found.add(normalizeApiPath(value));
  }
  return found;
}

function walkRouteFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkRouteFiles(absolute);
    return entry.name === "route.ts" ? [absolute] : [];
  });
}

export function documentedHeadings(doc) {
  return doc
    .split(/\r?\n/)
    .filter((line) => line.startsWith("### "))
    .flatMap((line) => [...extractApiPaths(line)].map((apiPath) => ({ line, apiPath })));
}

export function validateApiDocs(repoRoot = REPO_ROOT) {
  const problems = [];
  const docsPath = path.join(repoRoot, "docs", "api.md");
  const apiDir = path.join(repoRoot, "app", "api");
  if (!fs.existsSync(docsPath)) {
    fail(problems, "docs/api.md is missing");
    return problems;
  }
  const doc = fs.readFileSync(docsPath, "utf8");
  const docPaths = extractApiPaths(doc);
  const outOfScopeStart = doc.indexOf("## Out of scope");
  const outOfScope = outOfScopeStart === -1 ? new Set() : extractApiPaths(doc.slice(outOfScopeStart));

  const routes = new Map();
  for (const file of walkRouteFiles(apiDir)) {
    const apiPath = normalizeApiPath(routePathForFile(repoRoot, file));
    const marker = classifyRoute(fs.readFileSync(file, "utf8"));
    routes.set(apiPath, { file: path.relative(repoRoot, file).replace(/\\/g, "/"), marker });
  }

  for (const [apiPath, route] of routes) {
    if (route.marker === "internal") continue;
    if (!docPaths.has(apiPath)) {
      fail(problems, `${route.file}: @${route.marker} route is not documented in docs/api.md -> ${apiPath}`);
    }
  }

  for (const { line, apiPath } of documentedHeadings(doc)) {
    const route = routes.get(apiPath);
    if (!route) {
      fail(problems, `docs/api.md: documented endpoint has no route file -> ${apiPath} (${line.trim()})`);
      continue;
    }
    if (route.marker === "internal") {
      fail(problems, `docs/api.md: documented endpoint has no public marker -> ${apiPath} (${route.file})`);
    }
  }

  for (const apiPath of outOfScope) {
    if (routes.get(apiPath)?.marker === "public") {
      fail(problems, `docs/api.md: @public route is also listed as out-of-scope -> ${apiPath}`);
    }
  }

  return problems;
}

export function main() {
  const problems = validateApiDocs(REPO_ROOT);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[api-docs] ${problem}`);
    console.error(`[api-docs] ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  console.log("[api-docs] public route markers and docs/api.md agree");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main();
}
