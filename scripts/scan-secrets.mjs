#!/usr/bin/env node
// Lightweight pre-commit secret scanner. No external deps.
//
// Usage:
//   node scripts/scan-secrets.mjs --staged   # only files staged in `git add`
//   node scripts/scan-secrets.mjs --all      # all tracked files
//   node scripts/scan-secrets.mjs <files...> # explicit list
//
// Exits non-zero (1) if any pattern matches. Intended as a `pre-commit`
// hook so the commit aborts before a secret is written to history. False
// positives can be suppressed inline with `// jarela-secret-ok` on the
// same line (or any of: `// nosecret`, `# nosecret`, `/* nosecret */`).
//
// Scope: known high-value, low-false-positive prefixes for vendors this
// project actually integrates with. We deliberately do NOT use generic
// entropy heuristics — they generate too much noise and trained users
// learn to bypass them.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** @type {{name: string, re: RegExp}[]} */
const PATTERNS = [
  { name: "OpenAI / DeepSeek-style key",       re: /\bsk-[a-zA-Z0-9_-]{20,}\b/ },
  { name: "GitHub PAT (classic)",              re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub user-to-server token",       re: /\bghu_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub server-to-server token",     re: /\bghs_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub refresh token",              re: /\bghr_[A-Za-z0-9]{30,}\b/ },
  { name: "GitHub OAuth client secret",        re: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: "Google API key",                    re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "Google OAuth client secret",        re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google service-account/refresh",    re: /\bAQ\.Ab8RN6[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic API key",                 re: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/ },
  { name: "Slack token",                       re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe live key",                   re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key id",                 re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Private key block",                 re: /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/ },
];

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", "coverage",
  ".turbo", ".cache", "frontend/dist", "frontend/.vite",
]);

// Files that legitimately reference these patterns (the scanner itself,
// known-rotated history docs, the test fixtures). Add sparingly.
const ALLOW_PATHS = new Set([
  "scripts/scan-secrets.mjs",
]);

const SAFE_LINE_MARKERS = /(jarela-secret-ok|nosecret)/i;

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
  const parts = path.split(/[\\/]/);
  return parts.some((p) => SKIP_DIRS.has(p));
}

function isProbablyBinary(buf) {
  // Heuristic: any NUL byte in first 8KB → binary. Cheap and reliable.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  return slice.includes(0);
}

function scanFile(path) {
  let buf;
  try {
    const st = statSync(path);
    if (!st.isFile()) return [];
    if (st.size > 2 * 1024 * 1024) return []; // skip > 2MB
    buf = readFileSync(path);
  } catch {
    return []; // file deleted/renamed mid-scan
  }
  if (isProbablyBinary(buf)) return [];

  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SAFE_LINE_MARKERS.test(line)) continue;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        hits.push({ path, line: i + 1, kind: name, sample: line.trim().slice(0, 120) });
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

  const files = listFiles(mode, explicit).filter((p) => !shouldSkip(p));

  let hits = [];
  for (const f of files) {
    hits = hits.concat(scanFile(resolve(process.cwd(), f)));
  }

  if (hits.length === 0) {
    if (mode !== "staged") {
      console.log(`scan-secrets: clean (${files.length} files)`);
    }
    process.exit(0);
  }

  console.error("scan-secrets: FAILED — possible secrets found:");
  for (const h of hits) {
    console.error(`  ${h.path}:${h.line}  [${h.kind}]`);
    console.error(`    > ${h.sample}`);
  }
  console.error("");
  console.error("If this is a confirmed false positive, append `// jarela-secret-ok`");
  console.error("(or `# nosecret`) to the offending line, or rotate the leaked credential.");
  process.exit(1);
}

main();
