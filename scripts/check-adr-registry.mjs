#!/usr/bin/env node
// Lint check for the ADR registry.
//
// ADR numbers are citation keys: code comments and architecture docs refer to
// "ADR-0123" without a filename. Two files sharing a number make that
// reference ambiguous, and a reference to a missing number is a dead link.
//
// Verifies:
//   1. Every docs/adr/<NNNN>-*.md prefix is unique.
//   2. Every ADR-NNNN reference in project documentation resolves to a file.
//   3. Every relative link inside an ADR resolves.
//
// The CHANGELOG is excluded: generated release notes are historical records and
// may cite the identifier that was current at the time.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import url from "node:url";
import { extractMarkdownLinks } from "./check-agent-docs.mjs";

const SELF_PATH = url.fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..");
const REFERENCE_DOCS = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "docs"];
const ADR_ID = /ADR-(\d{4})/g;

function fail(problems, message) {
  problems.push(message);
}

function walkMarkdown(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkMarkdown(absolute);
    return entry.name.endsWith(".md") ? [absolute] : [];
  });
}

export function collectAdrFiles(repoRoot) {
  const directory = path.join(repoRoot, "docs", "adr");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .map((name) => ({
      name,
      number: name.slice(0, 4),
      file: `docs/adr/${name}`,
    }));
}

export function referenceDocuments(repoRoot) {
  const files = [];
  for (const entry of REFERENCE_DOCS) {
    const absolute = path.join(repoRoot, entry);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isDirectory()) {
      files.push(...walkMarkdown(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files.filter((file) => !file.endsWith("CHANGELOG.md"));
}

function ignoredPaths(repoRoot, targets) {
  if (targets.length === 0) return new Set();
  const result = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: repoRoot,
    input: targets.join("\n"),
    encoding: "utf8",
  });
  if (result.error || result.status === 128) return new Set();
  return new Set(
    (result.stdout ?? "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((target) => target.split(path.sep).join("/")),
  );
}

export function validateAdrLinks(repoRoot) {
  const problems = [];
  const directory = path.join(repoRoot, "docs", "adr");
  const references = [];
  for (const adr of collectAdrFiles(repoRoot)) {
    const absolute = path.join(repoRoot, adr.file);
    for (const link of extractMarkdownLinks(fs.readFileSync(absolute, "utf8"))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
      const target = link.split("#")[0];
      if (!target) continue;
      // Inline examples such as [label](url) are prose, not file references.
      if (!target.includes("/") && !/\.[a-z0-9]+$/i.test(target)) continue;
      references.push({ adr, link, absolute: path.join(directory, target) });
    }
  }

  const candidates = references
    .filter(({ absolute }) => fs.existsSync(absolute))
    .map(({ absolute }) => path.relative(repoRoot, absolute).split(path.sep).join("/"))
    .filter((target) => target && !target.startsWith(".."));
  const ignored = ignoredPaths(repoRoot, candidates);

  for (const { adr, link, absolute } of references) {
    if (!fs.existsSync(absolute)) {
      fail(problems, `${adr.file}: broken markdown link -> ${link}`);
      continue;
    }
    // A generated file can exist locally while absent from a clean CI
    // checkout, so a link to it is not a durable reference.
    const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
    if (ignored.has(relative)) {
      fail(problems, `${adr.file}: link target is generated and not checked in -> ${link}`);
    }
  }
  return problems;
}

export function validateAdrRegistry(repoRoot = REPO_ROOT) {
  const problems = [];
  const adrs = collectAdrFiles(repoRoot);
  const byNumber = new Map();
  for (const adr of adrs) {
    byNumber.set(adr.number, [...(byNumber.get(adr.number) ?? []), adr.file]);
  }
  for (const [number, files] of byNumber) {
    if (files.length > 1) {
      fail(problems, `ADR-${number} is duplicated by ${files.join(" and ")}`);
    }
  }

  for (const file of referenceDocuments(repoRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(ADR_ID)) {
      const number = match[1];
      const files = byNumber.get(number);
      const label = path.relative(repoRoot, file).replace(/\\/g, "/");
      if (!files || files.length === 0) {
        fail(problems, `${label}: references ADR-${number}, but no docs/adr/${number}-*.md exists`);
      }
    }
  }

  problems.push(...validateAdrLinks(repoRoot));
  return problems;
}

export function main() {
  const problems = validateAdrRegistry(REPO_ROOT);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[adr-registry] ${problem}`);
    console.error(`[adr-registry] ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[adr-registry] ${collectAdrFiles(REPO_ROOT).length} ADRs with unique identifiers and resolvable links`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main();
}
