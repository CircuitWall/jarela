#!/usr/bin/env node
// Lightweight scanner for organization-specific identifiers that must not land
// in the public repository. No external dependencies.
//
// Usage:
//   node scripts/scan-sensitive-terms.mjs --all
//   node scripts/scan-sensitive-terms.mjs --staged
//   node scripts/scan-sensitive-terms.mjs <files...>
//
// False positives can be suppressed inline with `jarela-sensitive-ok` or
// `nosecret` on the same line. Keep the blocklist small and high-confidence.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Brand entries use the same lowercase slug shape as the simple-icons-backed
// provider logo catalog. Keep only fingerprints here so this scanner is not
// itself a public fixture listing sensitive organization names.
const BLOCKED_FINGERPRINTS = [
  { name: "blocked brand slug", sha256: "e759968ca9278b8dde9f515ff1957813343dc35dbd2e5f68b38b5a17e29fe541" },
  { name: "blocked brand slug", sha256: "07863e7a6a2154ba864a71b0818c5ed32f78999430254b2e272d461fcd0d34eb" },
  { name: "blocked brand slug", sha256: "268ef950ed2a699ca80f0585189ada6f12621742b9f21f82e78864cfb53ad531" },
  { name: "blocked brand slug", sha256: "afe4d16f403a383f07814bbe04a5e7c5a7dc62ba5ce4040fc85514c29e0e88ae" },
  { name: "blocked brand slug", sha256: "ee46e2d141d53f08cc6dc5102319ddb97817480ce931d2b6381bf7ccca94bed0" },
  { name: "blocked brand slug", sha256: "e539cb6d872a97e53ff8331e18a07180b8a5dceabbabfa5644a547a5603be2d5" },
  { name: "blocked brand slug", sha256: "45cd2fb5a170129204e68c2dec80adc44fd0b74572da86b73e6dbb81c9ba197b" },
  { name: "blocked brand slug", sha256: "a5c1835f2f1f4d4d0db26a840ca90c1dc156e01cdc57b339bd11a4c68e9172f7" },
  { name: "blocked brand slug", sha256: "efc68bdfc744cb70e16f0527cabd6d40f724774a0fc11955dc454c95fec4ffcb" },
  { name: "blocked brand slug", sha256: "4b1f6f530975ef68d8f30d663efe02fb1e20ca2fdde8c5416ecfeb21fb881e96" },
  { name: "blocked brand slug", sha256: "4ef9bfe6a5402861fd19b51cdbe76e50ac1cd3cf36e3d20530d57f5dd13ab60e" },
  { name: "blocked brand slug", sha256: "bf35b3e3b9bb3050f1b5e904bcbb425985adecec6ac26ac4b471936e9425ca02" },
  { name: "blocked brand slug", sha256: "71f566aba763fb7636f03bfeb321c6d4934d4a6d5cb777c49b1c1595260c573b" },
  { name: "blocked brand slug", sha256: "ce749e840dcada0f9196edd49327ae5b3ab16f1d0405e72c1cb7d62b04538a42" },
  { name: "blocked brand slug", sha256: "62fd6c7860342a316c30c63d12f860125feccbf30e914d51dee6c2fdced4f606" },
  { name: "blocked brand slug", sha256: "74ca38ef9d349c49ad3142122715a73576ea0c6db952d7b845561a04207ece96" },
  { name: "blocked brand slug", sha256: "cd1025489027cbad620429856c143eccd0fc6279c57b931817173841608fe5f7" },
  { name: "blocked brand slug", sha256: "a480a469d4e9ebf4f6ba7c7377bd89c9c67fe7ce7ebdd83347bad9a3e2679786" },
  { name: "blocked brand slug", sha256: "3f9d6ae763adc5d79a13fbcd0b579f03e0d3654c3089c2d03140fb6abc029fa4" },
  { name: "blocked brand slug", sha256: "0d6f52f4c5a8d20c589e6ab66451fad38d0ddea79fb50fde348d922d884b2dbc" },
];

const BLOCKED_BY_HASH = new Map(BLOCKED_FINGERPRINTS.map((item) => [item.sha256, item]));
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_-]*/g;

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", "coverage",
  ".turbo", ".cache", "frontend/dist", "frontend/.vite",
]);

const ALLOW_PATHS = new Set([
  "scripts/scan-sensitive-terms.mjs",
  "package.json",
  "package-lock.json",
]);

const PACKAGE_MANIFEST_RE = /^packages\/[^/]+\/package\.json$/;

const SAFE_LINE_MARKERS = /(jarela-sensitive-ok|nosecret)/i;

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

function candidateTerms(line) {
  const terms = new Set();
  for (const match of line.matchAll(TOKEN_RE)) {
    const token = match[0].toLowerCase();
    terms.add(token);
    for (const part of token.split(/[-_]+/)) {
      if (part) terms.add(part);
    }
  }
  return terms;
}

function listFiles(mode, explicit) {
  if (mode === "staged") {
    const out = execFileSync("git", [
      "diff", "--cached", "--name-only", "--diff-filter=ACMR",
    ]).toString();
    return out.split(/\r?\n/).filter(Boolean);
  }
  if (mode === "all") {
    const out = execFileSync("git", ["ls-files"]).toString();
    return out.split(/\r?\n/).filter(Boolean);
  }
  return explicit;
}

function shouldSkip(path) {
  if (ALLOW_PATHS.has(path)) return true;
  if (PACKAGE_MANIFEST_RE.test(path)) return true;
  const parts = path.split(/[\\/]/);
  return parts.some((part) => SKIP_DIRS.has(part));
}

function isProbablyBinary(buf) {
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  return slice.includes(0);
}

function scanFile(path) {
  let buf;
  try {
    const st = statSync(path);
    if (!st.isFile()) return [];
    if (st.size > 2 * 1024 * 1024) return [];
    buf = readFileSync(path);
  } catch {
    return [];
  }
  if (isProbablyBinary(buf)) return [];

  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (SAFE_LINE_MARKERS.test(line)) continue;
    for (const term of candidateTerms(line)) {
      const blocked = BLOCKED_BY_HASH.get(fingerprint(term));
      if (blocked) {
        hits.push({ path, line: i + 1, kind: blocked.name, sample: line.trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  let mode = "explicit";
  let explicit = [];
  if (args.includes("--staged")) mode = "staged";
  else if (args.includes("--all")) mode = "all";
  else explicit = args;

  const files = listFiles(mode, explicit).filter((path) => !shouldSkip(path));
  let hits = [];
  for (const file of files) {
    hits = hits.concat(scanFile(resolve(process.cwd(), file)));
  }

  if (hits.length === 0) {
    if (mode !== "staged") console.log(`scan-sensitive-terms: clean (${files.length} files)`);
    process.exit(0);
  }

  console.error("scan-sensitive-terms: FAILED - blocked sensitive terms found:");
  for (const hit of hits) {
    console.error(`  ${hit.path}:${hit.line}  [${hit.kind}]`);
    console.error(`    > ${hit.sample}`);
  }
  console.error("");
  console.error("If this is a confirmed false positive, append `jarela-sensitive-ok`");
  console.error("or `nosecret` to the offending line.");
  process.exit(1);
}

main();
